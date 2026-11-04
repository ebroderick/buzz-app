//! Read-only acquisition. Preview owns immutable artifacts; installation never rereads a source.
use crate::{
    access::{AccessRules, Transport},
    artifact_from_parts, err, hash, icon_revision,
    managed::{valid_commit, valid_reference},
    Catalog, GitSource, InstallSource, Manager, Manifest, Release, ReloadSource, Result, BASE64,
    LIMIT, MAX_ICON_BYTES, MAX_README_BYTES,
};
use base64::Engine as _;
use nostr::event::Event;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const MAX_ENTRIES: usize = 20_000;
const MAX_PLUGINS: usize = 32;
const MAX_PREVIEW_BYTES: usize = 32 * 1024 * 1024;
const MAX_REPO_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub path: String,
    pub manifest: Manifest,
    pub revision: String,
    pub publisher: Option<String>,
    pub readme_revision: Option<String>,
    pub icon_png_revision: Option<String>,
    pub icon_jpg_revision: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub token: String,
    pub source: String,
    pub commit: Option<String>,
    pub candidates: Vec<Candidate>,
    pub warnings: Vec<String>,
}

pub struct PreparedImport {
    pub preview: Preview,
    folder_root: Option<PathBuf>,
    git_source: Option<GitSource>,
    artifacts: BTreeMap<String, Release>,
    unbuilt: Vec<(String, Option<String>, String)>,
}
impl PreparedImport {
    fn new(source: String, commit: Option<String>, folder_root: Option<PathBuf>) -> Result<Self> {
        // An opaque per-preview identity, independent of plugin IDs or source paths.
        let nonce = tempfile::NamedTempFile::new().map_err(err)?;
        Ok(Self {
            preview: Preview {
                token: hash(nonce.path().as_os_str().as_encoded_bytes()),
                source,
                commit,
                candidates: vec![],
                warnings: vec![],
            },
            folder_root,
            git_source: None,
            artifacts: BTreeMap::new(),
            unbuilt: vec![],
        })
    }
    fn add(&mut self, path: String, artifact: Result<Release>) -> Result<()> {
        match artifact.and_then(|release| {
            let artifact = release.artifact()?;
            Ok((release, artifact))
        }) {
            Ok((release, artifact)) => {
                if self.artifacts.contains_key(&path) {
                    return Err("Duplicate plugin folder identity".into());
                }
                if self.artifacts.len() >= MAX_PLUGINS
                    || self
                        .artifacts
                        .values()
                        .map(|item| item.bytes.len())
                        .sum::<usize>()
                        + release.bytes.len()
                        > MAX_PREVIEW_BYTES
                {
                    return Err("Too many plugin artifacts; choose a smaller folder or repository (32 plugins / 32 MiB maximum)".into());
                }
                self.preview.candidates.push(Candidate {
                    path: path.clone(),
                    manifest: artifact.manifest.clone(),
                    revision: hash(&release.bytes),
                    publisher: release.publisher(),
                    readme_revision: artifact.readme_revision(),
                    icon_png_revision: icon_revision(artifact.icon_png.as_deref()),
                    icon_jpg_revision: icon_revision(artifact.icon_jpg.as_deref()),
                });
                self.artifacts.insert(path, release);
            }
            Err(reason) => {
                if self.preview.warnings.len() < MAX_PLUGINS {
                    let folder = if path == "." {
                        "Selected folder"
                    } else {
                        &path
                    };
                    self.preview.warnings.push(format!("{folder}: {reason}"));
                }
            }
        }
        Ok(())
    }
    // A source manifest without code can be the parent of its built output.
    // Defer only that case until discovery can match the same plugin ID below it.
    fn add_unbuilt(&mut self, path: String, manifest: Result<String>, reason: String) {
        let (id, reason) = match manifest {
            Ok(text) => (
                serde_json::from_str::<Manifest>(&text).ok().map(|m| m.id),
                reason,
            ),
            Err(error) => (None, error),
        };
        self.unbuilt.push((path, id, reason));
    }
    fn finish(mut self) -> Result<Self> {
        for (path, id, reason) in std::mem::take(&mut self.unbuilt) {
            let found_build = id.is_some_and(|id| {
                self.preview.candidates.iter().any(|candidate| {
                    candidate.manifest.id == id
                        && candidate.path != path
                        && (path == "." || Path::new(&candidate.path).starts_with(&path))
                })
            });
            if !found_build {
                self.add(path, Err(reason))?;
            }
        }
        Ok(self)
    }
    pub fn install(&self, manager: &Manager, token: &str, path: &str) -> Result<Catalog> {
        if token != self.preview.token {
            return Err("This import preview expired. Choose the source again.".into());
        }
        let release = self
            .artifacts
            .get(path)
            .ok_or("Choose a listed plugin folder")?;
        let source = self
            .folder_root
            .clone()
            .map(|root| ReloadSource::folder(root, path.to_owned()).map(InstallSource::Folder))
            .transpose()?
            .or_else(|| {
                self.git_source.clone().map(|mut source| {
                    source.path = path.to_owned();
                    InstallSource::Git(source)
                })
            });
        manager.install_artifact(release, source)
    }
}

#[derive(Deserialize)]
pub struct FolderUpload {
    pub source: String,
    pub files: Vec<ImportFile>,
}

#[derive(Deserialize)]
pub struct ImportFile {
    pub path: String,
    pub text: Option<String>,
    pub base64: Option<String>,
}

/// Browser drops supply package contents, never trusted local filesystem paths.
/// Reuse the folder reader and signature checks, without retaining a reload source.
pub fn prepare_upload(upload: FolderUpload) -> Result<PreparedImport> {
    if upload.source.is_empty()
        || upload.source.len() > 255
        || upload.source.chars().any(char::is_control)
    {
        return Err("Invalid dropped folder name".into());
    }
    if upload.files.len() > MAX_ENTRIES {
        return Err("Folder exceeds 20,000 entries; choose a smaller folder".into());
    }
    let scratch = tempfile::tempdir().map_err(err)?;
    let mut seen = std::collections::BTreeSet::new();
    let mut bytes = 0usize;
    for file in upload.files {
        let parts: Vec<_> = file.path.split('/').collect();
        if parts.len() > 33
            || file.path.len() > 4096
            || parts.iter().any(|part| {
                part.is_empty()
                    || *part == "."
                    || *part == ".."
                    || part.contains(['\\', ':'])
                    || part.chars().any(char::is_control)
            })
            || !matches!(
                parts.last().copied(),
                Some(
                    "manifest.json"
                        | "plugin.js"
                        | "plugin.artifact.json"
                        | "plugin.signature.json"
                        | "README.md"
                        | "icon.png"
                        | "icon.jpg"
                )
            )
            || !seen.insert(file.path.clone())
        {
            return Err("Invalid or duplicate dropped plugin path".into());
        }
        let name = parts.last().copied().unwrap();
        let icon = matches!(name, "icon.png" | "icon.jpg");
        let limit = match name {
            "README.md" => MAX_README_BYTES,
            "icon.png" | "icon.jpg" => MAX_ICON_BYTES,
            _ => LIMIT as usize,
        };
        let contents = match (file.text, file.base64) {
            (Some(text), None) => text.into_bytes(),
            (None, Some(encoded)) if icon && encoded.len() <= limit.div_ceil(3) * 4 => {
                BASE64.decode(encoded).map_err(err)?
            }
            _ => return Err("Invalid dropped plugin file encoding".into()),
        };
        bytes = bytes
            .checked_add(contents.len())
            .ok_or("Dropped folder is too large")?;
        if contents.len() > limit || bytes > MAX_PREVIEW_BYTES {
            return Err("Dropped plugin files exceed their file or 32 MiB total limit".into());
        }
        let path = scratch.path().join(&file.path);
        fs::create_dir_all(path.parent().ok_or("Invalid dropped plugin path")?).map_err(err)?;
        // Also reject aliases on case-insensitive filesystems instead of overwriting.
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(err)?
            .write_all(&contents)
            .map_err(err)?;
    }
    let mut prepared = prepare_folder(scratch.path())?;
    prepared.folder_root = None;
    prepared.preview.source = format!("Dropped folder: {}", upload.source);
    Ok(prepared)
}

/// Resolve the installed source natively; callers cannot supply an arbitrary path.
pub fn prepare_saved_folder(manager: &Manager, id: &str) -> Result<PreparedImport> {
    let plugin = manager
        .catalog()?
        .plugins
        .into_iter()
        .find(|plugin| plugin.manifest.id == id)
        .ok_or("Plugin is not installed")?;
    let Some(InstallSource::Folder(source)) = plugin.update_source else {
        return Err("Plugin has no saved folder source".into());
    };
    let mut prepared = prepare_folder(&source.root)?;
    if !prepared
        .preview
        .candidates
        .iter()
        .any(|candidate| candidate.path == source.path && candidate.manifest.id == id)
    {
        let prefix = if source.path == "." {
            "Selected folder"
        } else {
            &source.path
        };
        return Err(prepared
            .preview
            .warnings
            .iter()
            .find(|warning| warning.starts_with(&format!("{prefix}:")))
            .cloned()
            .unwrap_or_else(|| {
                "The saved folder no longer contains this plugin at its installed path.".into()
            }));
    }
    prepared
        .preview
        .candidates
        .retain(|candidate| candidate.path == source.path && candidate.manifest.id == id);
    prepared.artifacts.retain(|path, _| path == &source.path);
    Ok(prepared)
}

/// No preview is retained, installed, or published to the native import slot.
pub fn check_saved_folder(manager: &Manager, id: &str) -> Result<String> {
    let prepared = prepare_saved_folder(manager, id)?;
    prepared
        .preview
        .candidates
        .first()
        .map(|candidate| candidate.revision.clone())
        .ok_or_else(|| "Saved source has no candidate".into())
}

pub fn prepare_folder(directory: &Path) -> Result<PreparedImport> {
    if !fs::symlink_metadata(directory)
        .map_err(err)?
        .file_type()
        .is_dir()
    {
        return Err("Choose a regular folder, not a symbolic link".into());
    }
    let root = directory.canonicalize().map_err(err)?;
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut prepared = PreparedImport::new(root.display().to_string(), None, Some(root.clone()))?;
    let directory =
        cap_std::fs::Dir::open_ambient_dir(&root, cap_std::ambient_authority()).map_err(err)?;
    let mut pending = vec![(PathBuf::new(), 0)];
    let mut entries = 0;
    while let Some((relative, depth)) = pending.pop() {
        if Instant::now() >= deadline {
            return Err("Folder scan exceeded 60 seconds".into());
        }
        if depth > 32 {
            return Err("Folder nesting exceeds 32 levels; choose a smaller folder".into());
        }
        let mut has_manifest = false;
        let mut has_release = false;
        let mut has_code = false;
        for entry in directory
            .read_dir(if relative.as_os_str().is_empty() {
                Path::new(".")
            } else {
                &relative
            })
            .map_err(err)?
        {
            let entry = entry.map_err(err)?;
            entries += 1;
            if entries > MAX_ENTRIES {
                return Err("Folder exceeds 20,000 entries; choose a smaller folder".into());
            }
            let kind = entry.file_type().map_err(err)?;
            let name = entry.file_name();
            if name == "manifest.json" {
                has_manifest = true;
            }
            if name == "plugin.js" {
                has_code = true;
            }
            if name == "plugin.artifact.json" || name == "plugin.signature.json" {
                has_release = true;
            }
            // Hidden folders hold VCS and tool state, including other checkouts such as
            // .claude/worktrees; choose one of those folders directly to import from it.
            if kind.is_dir()
                && !name.as_encoded_bytes().starts_with(b".")
                && name != "node_modules"
                && name != "target"
            {
                pending.push((relative.join(name), depth + 1));
            }
        }
        if has_manifest || has_release {
            let path = candidate_path(&relative)?;
            if !has_release && !has_code {
                prepared.add_unbuilt(
                    path,
                    read_source_file(&directory, &relative.join("manifest.json")),
                    format!("Missing file: {}", relative.join("plugin.js").display()),
                );
                continue;
            }
            let artifact = read_package(&directory, &relative).and_then(|release| {
                if has_release && release.signature.is_none() {
                    Err("Signed plugin release disappeared during folder scan".into())
                } else {
                    Ok(release)
                }
            });
            prepared.add(path, artifact)?;
        }
    }
    prepared
        .preview
        .candidates
        .sort_by(|a, b| a.path.cmp(&b.path));
    prepared.finish()
}

pub(crate) fn read_package(directory: &cap_std::fs::Dir, relative: &Path) -> Result<Release> {
    let artifact_path = relative.join("plugin.artifact.json");
    let signature_path = relative.join("plugin.signature.json");
    let present = |path| match directory.symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(err(error)),
    };
    let has_artifact = present(&artifact_path)?;
    let has_signature = present(&signature_path)?;
    if has_artifact || has_signature {
        if !has_artifact || !has_signature {
            return Err("Incomplete signed plugin release pair".into());
        }
        return Ok(Release {
            bytes: read_source_file(directory, &artifact_path)?.into_bytes(),
            signature: Some(
                serde_json::from_str(&read_source_file(directory, &signature_path)?)
                    .map_err(err)?,
            ),
        });
    }
    Ok(Release {
        bytes: artifact_from_source(directory, relative)?,
        signature: None,
    })
}

pub(crate) fn prepare_unsigned_artifact(directory: &Path) -> Result<Vec<u8>> {
    let root =
        cap_std::fs::Dir::open_ambient_dir(directory, cap_std::ambient_authority()).map_err(err)?;
    artifact_from_source(&root, Path::new("."))
}

fn artifact_from_source(directory: &cap_std::fs::Dir, relative: &Path) -> Result<Vec<u8>> {
    artifact_from_parts(
        &read_source_file(directory, &relative.join("manifest.json"))?,
        read_source_file(directory, &relative.join("plugin.js"))?,
        read_optional_source_file(directory, &relative.join("README.md"), MAX_README_BYTES)?,
        read_optional_source_bytes(directory, &relative.join("icon.png"), MAX_ICON_BYTES)?,
        read_optional_source_bytes(directory, &relative.join("icon.jpg"), MAX_ICON_BYTES)?,
    )
}

fn candidate_path(relative: &Path) -> Result<String> {
    if relative.as_os_str().is_empty() {
        return Ok(".".into());
    }
    Ok(relative
        .components()
        .map(|c| {
            c.as_os_str()
                .to_str()
                .ok_or("Plugin folder names must be UTF-8")
        })
        .collect::<std::result::Result<Vec<_>, _>>()?
        .join("/"))
}

// All descendant resolution is relative to an opened directory capability: an ancestor
// swapped for an escaping symlink cannot redirect reads outside the selected folder.
pub(crate) fn read_source_file(directory: &cap_std::fs::Dir, path: &Path) -> Result<String> {
    String::from_utf8(read_source_bytes(directory, path, LIMIT as usize)?).map_err(err)
}

fn read_optional_source_file(
    directory: &cap_std::fs::Dir,
    path: &Path,
    limit: usize,
) -> Result<Option<String>> {
    read_optional_source_bytes(directory, path, limit)?
        .map(|bytes| {
            String::from_utf8(bytes).map_err(|_| format!("{} must be UTF-8", path.display()))
        })
        .transpose()
}

fn read_optional_source_bytes(
    directory: &cap_std::fs::Dir,
    path: &Path,
    limit: usize,
) -> Result<Option<Vec<u8>>> {
    // Directory entries preserve spelling even on case-insensitive filesystems.
    // Only the conventional exact filename participates in the package.
    let mut found = false;
    for entry in directory
        .read_dir(
            path.parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or(Path::new(".")),
        )
        .map_err(err)?
    {
        if entry.map_err(err)?.file_name() == path.file_name().ok_or("Missing asset filename")? {
            found = true;
            break;
        }
    }
    if !found {
        return Ok(None);
    }
    match directory.symlink_metadata(path) {
        Ok(_) => read_source_bytes(directory, path, limit).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(err(error)),
    }
}

fn read_source_bytes(directory: &cap_std::fs::Dir, path: &Path, limit: usize) -> Result<Vec<u8>> {
    let read_error = |error: std::io::Error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            format!("Missing file: {}", path.display())
        } else {
            format!("Could not read {}: {error}", path.display())
        }
    };
    if !directory
        .symlink_metadata(path)
        .map_err(read_error)?
        .file_type()
        .is_file()
    {
        return Err("Plugin files must be regular files, not symbolic links".into());
    }
    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = directory.open_with(path, &options).map_err(read_error)?;
    if !file.metadata().map_err(read_error)?.is_file() {
        return Err("Plugin files must be regular files".into());
    }
    let mut bytes = Vec::new();
    file.into_std()
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(read_error)?;
    if bytes.len() > limit {
        return Err(format!("{} exceeds its size limit", path.display()));
    }
    Ok(bytes)
}

/// Only explicit HTTPS/SSH transports. No local paths, URL helpers, credentials in HTTPS,
/// GitHub web tree URLs, or shell interpretation. A separate ref avoids ambiguous slash parsing.
pub fn repository_url(input: &str) -> Result<String> {
    let input = input.trim();
    if input.len() > 2048 {
        return Err("Repository URL is too long".into());
    }
    let scp = input.split_once(':').filter(|(authority, _)| {
        !input.contains("://")
            && !authority.contains('/')
            && authority
                .split_once('@')
                .is_some_and(|(user, host)| !user.is_empty() && !host.is_empty())
    });
    let expanded = if let Some((host, path)) = scp {
        format!("ssh://{host}/{path}")
    } else if input.starts_with("github.com/") {
        format!("https://{input}")
    } else if !input.contains(':') && input.split('/').count() == 2 {
        format!("https://github.com/{input}")
    } else {
        input.into()
    };
    let url = url::Url::parse(&expanded).map_err(|_| "Enter an HTTPS or SSH repository URL")?;
    if !["https", "ssh"].contains(&url.scheme())
        || url.host_str().is_none()
        || url.host_str().is_some_and(|host| host.starts_with('-'))
        || url.username().starts_with('-')
        || url.password().is_some()
        || (url.scheme() == "https" && !url.username().is_empty())
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path().trim_matches('/').is_empty()
        || expanded.split_once("://").is_some_and(|(_, rest)| {
            rest.split(['/', '?', '#'])
                .next()
                .is_some_and(|a| a.contains('%'))
        })
        || expanded
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(
            "Use an HTTPS or SSH repository URL without a password, query or fragment".into(),
        );
    }
    let host = url.host_str().unwrap_or_default().trim_end_matches('.');
    let host = host.strip_prefix("www.").unwrap_or(host);
    if host.eq_ignore_ascii_case("github.com")
        && url.path().trim_matches('/').split('/').count() != 2
    {
        return Err("Use the GitHub repository URL, not a tree/file URL. Enter the branch or tag separately, then select a plugin folder.".into());
    }
    Ok(url.to_string())
}

struct Git {
    scratch: tempfile::TempDir,
    deadline: Instant,
    ssh_auth_sock: Option<PathBuf>,
    /// Repository URL and its NIP-98 token. Git sends the header only to that URL prefix.
    authorization: Option<(String, String)>,
    federated_header: Option<String>,
    retired: Option<Box<dyn Fn() -> bool + Send>>,
}
impl Git {
    fn new() -> Result<Self> {
        Ok(Self {
            scratch: tempfile::tempdir().map_err(err)?,
            deadline: Instant::now() + Duration::from_secs(60),
            ssh_auth_sock: None,
            authorization: None,
            federated_header: None,
            retired: None,
        })
    }
    fn command(&self) -> Command {
        let mut command = Command::new("git");
        command.env_clear();
        // Retain SSH-agent authentication and platform tool lookup, but not Git's ambient
        // repository/config/transport overrides. No credential helpers or interactive prompts.
        for key in ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "SSH_AUTH_SOCK"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        if let Some(socket) = &self.ssh_auth_sock {
            command.env("SSH_AUTH_SOCK", socket);
        }
        let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
        command
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", null)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env(
                "GIT_SSH_COMMAND",
                format!("ssh -F {null} -oBatchMode=yes -oStrictHostKeyChecking=yes"),
            )
            .args([
                "-c",
                "protocol.allow=never",
                "-c",
                "protocol.https.allow=always",
                "-c",
                "protocol.ssh.allow=always",
                "-c",
                "core.fsmonitor=false",
                "-c",
                &format!("core.hooksPath={null}"),
            ])
            .current_dir(self.scratch.path());
        if let Some((url, token)) = &self.authorization {
            // Environment, not argv: other processes cannot read the token from `ps`.
            // No redirects, so the header never follows the request to another URL.
            let mut settings = vec![
                (
                    format!("http.{url}.extraHeader"),
                    format!("Authorization: Nostr {token}"),
                ),
                ("http.followRedirects".into(), "false".into()),
            ];
            if let Some(header) = &self.federated_header {
                settings.push((
                    format!("http.{url}.extraHeader"),
                    format!("Nostr-Federated-Identity: {header}"),
                ));
            }
            command.env("GIT_CONFIG_COUNT", settings.len().to_string());
            for (index, (key, value)) in settings.into_iter().enumerate() {
                command
                    .env(format!("GIT_CONFIG_KEY_{index}"), key)
                    .env(format!("GIT_CONFIG_VALUE_{index}"), value);
            }
        }
        command
    }
    fn run(&self, args: &[&str], limit: u64) -> Result<Vec<u8>> {
        let mut command = self.command();
        command.args(args);
        self.run_command(command, limit)
    }
    fn run_command(&self, mut command: Command, limit: u64) -> Result<Vec<u8>> {
        if self.retired.as_ref().is_some_and(|retired| retired()) {
            return Err("Repository authorization retired".into());
        }
        if Instant::now() >= self.deadline {
            return Err("Repository import exceeded 60 seconds".into());
        }
        let output = tempfile::tempfile().map_err(err)?;
        let errors = tempfile::tempfile().map_err(err)?;
        command
            .stdin(Stdio::null())
            .stdout(output.try_clone().map_err(err)?)
            .stderr(errors.try_clone().map_err(err)?);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        if self.retired.as_ref().is_some_and(|retired| retired()) {
            return Err("Repository authorization retired".into());
        }
        if Instant::now() >= self.deadline {
            return Err("Repository import exceeded 60 seconds".into());
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start Git: {e}. Install Git to load repositories."))?;
        let result = (|| loop {
            if self.retired.as_ref().is_some_and(|retired| retired()) {
                return Err("Repository authorization retired".into());
            }
            if Instant::now() >= self.deadline {
                return Err("Repository import exceeded 60 seconds".into());
            }
            if output.metadata().map_err(err)?.len() > limit
                || errors.metadata().map_err(err)?.len() > LIMIT
            {
                return Err("Git output exceeds the import size limit".into());
            }
            if directory_size(self.scratch.path())? > MAX_REPO_BYTES {
                return Err("Repository exceeds the 256 MiB import limit".into());
            }
            if let Some(status) = child.try_wait().map_err(err)? {
                if !status.success() {
                    if self.federated_header.is_some() {
                        return Err("Git could not read the protected repository".into());
                    }
                    let text = read_output(errors, 4096)?;
                    return Err(format!(
                        "Git could not read this repository: {}",
                        String::from_utf8_lossy(&text).trim()
                    ));
                }
                return read_output(output, limit);
            }
            thread::sleep(Duration::from_millis(50));
        })();
        if result.is_err() {
            // Stop the complete Git/SSH transport group, not just its parent, before cleanup.
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .output();
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        result
    }
    fn read_plugins(&self, source: String, pinned: Option<&str>) -> Result<PreparedImport> {
        let commit = String::from_utf8(self.run(&["-C", "repository", "rev-parse", "HEAD"], 1024)?)
            .map_err(err)?
            .trim()
            .to_string();
        if pinned.is_some_and(|pinned| !commit.eq_ignore_ascii_case(pinned)) {
            return Err(format!(
                "The repository reference is at commit {commit}, not the required commit {}. The reference has moved; ask whoever manages this recommendation to update it.",
                pinned.unwrap_or_default()
            ));
        }
        let tree = self.run(
            &["-C", "repository", "ls-tree", "-rz", "--full-tree", "HEAD"],
            2 * 1024 * 1024,
        )?;
        let mut blobs = BTreeMap::new();
        let mut symlinks = std::collections::BTreeSet::new();
        for (index, entry) in tree
            .split(|b| *b == 0)
            .filter(|b| !b.is_empty())
            .enumerate()
        {
            if index >= MAX_ENTRIES {
                return Err("Repository exceeds 20,000 files; use a smaller repository".into());
            }
            let entry =
                std::str::from_utf8(entry).map_err(|_| "Repository filenames must be UTF-8")?;
            let (meta, path) = entry.split_once('\t').ok_or("Invalid Git tree")?;
            let mut meta = meta.split(' ');
            let mode = meta.next().unwrap_or_default();
            let kind = meta.next().unwrap_or_default();
            let oid = meta.next().unwrap_or_default();
            if mode == "120000" {
                symlinks.insert(path.to_string());
            }
            // Never check out a working tree: symlinks, submodules, attributes/filters and
            // repository scripts cannot become executable acquisition steps.
            if kind == "blob" && (mode == "100644" || mode == "100755") {
                blobs.insert(path.to_string(), oid.to_string());
            }
        }
        let mut prepared = PreparedImport::new(source, Some(commit), None)?;
        let parents: std::collections::BTreeSet<&str> = blobs
            .keys()
            .filter_map(|path| {
                [
                    "manifest.json",
                    "plugin.artifact.json",
                    "plugin.signature.json",
                ]
                .iter()
                .find_map(|name| {
                    path.strip_suffix(name)
                        .filter(|parent| parent.is_empty() || parent.ends_with('/'))
                })
            })
            .collect();
        for parent in parents {
            if parent
                .split('/')
                .any(|s| s == "node_modules" || s == "target")
            {
                continue;
            }
            let display = if parent.is_empty() {
                "."
            } else {
                parent.trim_end_matches('/')
            };
            let artifact_oid = blobs.get(&format!("{parent}plugin.artifact.json"));
            let signature_oid = blobs.get(&format!("{parent}plugin.signature.json"));
            if artifact_oid.is_some() || signature_oid.is_some() {
                let release = (|| {
                    let (Some(artifact_oid), Some(signature_oid)) = (artifact_oid, signature_oid)
                    else {
                        return Err("Incomplete signed plugin release pair".into());
                    };
                    let bytes = self.read_blob(artifact_oid)?;
                    let signature: Event =
                        serde_json::from_slice(&self.read_blob(signature_oid)?).map_err(err)?;
                    Ok(Release {
                        bytes,
                        signature: Some(signature),
                    })
                })();
                prepared.add(display.into(), release)?;
                continue;
            }
            let Some(manifest_oid) = blobs.get(&format!("{parent}manifest.json")) else {
                continue;
            };
            let Some(code_oid) = blobs.get(&format!("{parent}plugin.js")) else {
                let reason = "No built plugin.js beside manifest.json; build the plugin first";
                if symlinks.contains(&format!("{parent}plugin.js")) {
                    prepared.add(display.into(), Err(reason.into()))?;
                } else {
                    prepared.add_unbuilt(
                        display.into(),
                        self.read_blob(manifest_oid).and_then(|bytes| {
                            String::from_utf8(bytes)
                                .map_err(|_| "manifest.json must be UTF-8".into())
                        }),
                        reason.into(),
                    );
                }
                continue;
            };
            let artifact = (|| {
                for name in ["README.md", "icon.png", "icon.jpg"] {
                    if symlinks.contains(&format!("{parent}{name}")) {
                        return Err(format!(
                            "{name} must be a regular file, not a symbolic link"
                        ));
                    }
                }
                let manifest = String::from_utf8(self.read_blob(manifest_oid)?)
                    .map_err(|_| "manifest.json must be UTF-8")?;
                let code = String::from_utf8(self.read_blob(code_oid)?)
                    .map_err(|_| "plugin.js must be UTF-8")?;
                let readme = blobs
                    .get(&format!("{parent}README.md"))
                    .map(|oid| {
                        String::from_utf8(self.read_blob_limited(oid, MAX_README_BYTES as u64)?)
                            .map_err(|_| String::from("README.md must be UTF-8"))
                    })
                    .transpose()?;
                let icon = blobs
                    .get(&format!("{parent}icon.png"))
                    .map(|oid| self.read_blob_limited(oid, MAX_ICON_BYTES as u64))
                    .transpose()?;
                let jpg = blobs
                    .get(&format!("{parent}icon.jpg"))
                    .map(|oid| self.read_blob_limited(oid, MAX_ICON_BYTES as u64))
                    .transpose()?;
                artifact_from_parts(&manifest, code, readme, icon, jpg).map(|bytes| Release {
                    bytes,
                    signature: None,
                })
            })();
            prepared.add(display.into(), artifact)?;
        }
        prepared.finish()
    }

    fn read_blob(&self, oid: &str) -> Result<Vec<u8>> {
        self.read_blob_limited(oid, LIMIT)
    }

    fn read_blob_limited(&self, oid: &str, limit: u64) -> Result<Vec<u8>> {
        let size = String::from_utf8(self.run(&["-C", "repository", "cat-file", "-s", oid], 1024)?)
            .map_err(err)?;
        if size.trim().parse::<u64>().map_err(err)? > limit {
            return Err("File exceeds its size limit".into());
        }
        self.run(&["-C", "repository", "cat-file", "blob", oid], limit)
    }
}

/// A full commit ID that a Git import must resolve to. A distinct type keeps it from being
/// confused with the adjacent authorization strings.
#[derive(Clone, Copy, Debug)]
pub struct RequiredCommit<'a>(&'a str);
impl<'a> RequiredCommit<'a> {
    pub fn parse(commit: &'a str) -> Result<Self> {
        if valid_commit(commit) {
            Ok(Self(commit))
        } else {
            Err("Required commit must be a full 40 or 64 digit hexadecimal object ID".into())
        }
    }
}

/// `authorization` is a NIP-98 token that the caller signed for exactly this repository URL.
pub fn prepare_git(
    repository: &str,
    reference: &str,
    authorization: Option<&str>,
) -> Result<PreparedImport> {
    prepare_git_authorized(
        repository,
        reference,
        None,
        authorization,
        None,
        None,
        &crate::access::built_in(),
    )
}
/// Native FI remains native: headers are scoped to this repository through environment config.
/// `required` refuses a reference that no longer resolves to exactly that commit, and is the
/// only case where the installed commit is recorded in the saved source.
pub fn prepare_git_authorized(
    repository: &str,
    reference: &str,
    required: Option<RequiredCommit<'_>>,
    authorization: Option<&str>,
    federated_header: Option<&str>,
    retired: Option<Box<dyn Fn() -> bool + Send>>,
    access: &AccessRules,
) -> Result<PreparedImport> {
    let url = repository_url(repository)?;
    let reference = reference.trim();
    if !reference.is_empty() && !valid_reference(reference) {
        return Err("Enter a branch or tag name using letters, digits, dots, underscores, slashes or hyphens".into());
    }
    let mut git = Git::new()?;
    if let Some(token) = authorization {
        if token.is_empty()
            || token.len() > 8192
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
        {
            return Err("Invalid repository authorization".into());
        }
        git.authorization = Some((url.clone(), token.into()));
    }
    if let Some(header) = federated_header {
        if authorization.is_none()
            || header.len() > 8192
            || !header.starts_with("Bearer ")
            || header.chars().any(|c| c.is_control())
        {
            return Err("Invalid federated repository authorization".into());
        }
        git.federated_header = Some(header.into());
    }
    git.retired = retired;
    // Without a home directory `~/` sockets cannot be found, so no rule applies.
    let transport = match dirs::home_dir() {
        Some(home) => access.resolve(&url, authorization.is_some(), &home)?,
        None => Transport {
            clone_url: url.clone(),
            ssh_auth_sock: None,
            rule: None,
        },
    };
    if let Some(rule) = &transport.rule {
        eprintln!(
            "Repository access rule {rule}: reading {url} as {} with agent socket {}",
            transport.clone_url,
            agent_label(&transport)
        );
    }
    git.ssh_auth_sock = transport.ssh_auth_sock.clone();
    let mut args = vec![
        "clone",
        "--depth=1",
        "--single-branch",
        "--no-tags",
        "--no-checkout",
        "--template=",
    ];
    if !reference.is_empty() {
        args.extend(["--branch", reference]);
    }
    args.extend(["--", &transport.clone_url, "repository"]);
    git.run(&args, LIMIT)
        .map_err(|error| match &transport.rule {
            Some(rule) => format!(
                "{error} (repository access rule {rule}, agent socket {})",
                agent_label(&transport)
            ),
            None => error,
        })?;
    let mut prepared = git.read_plugins(url.clone(), required.map(|required| required.0))?;
    if git.retired.as_ref().is_some_and(|retired| retired()) {
        return Err("Repository authorization retired".into());
    }
    prepared.git_source = Some(git_source(
        url,
        reference,
        required,
        prepared.preview.commit.as_deref(),
    ));
    Ok(prepared)
}
/// Only a pinned import records its commit: an unpinned source stays readable by older
/// Buzz versions, which reject unknown registry fields.
fn git_source(
    repository: String,
    reference: &str,
    required: Option<RequiredCommit<'_>>,
    read: Option<&str>,
) -> GitSource {
    GitSource {
        repository,
        reference: reference.into(),
        path: ".".into(),
        commit: required.and(read).map(str::to_owned),
    }
}
fn agent_label(transport: &Transport) -> String {
    transport
        .ssh_auth_sock
        .as_ref()
        .map_or("inherited".into(), |socket| socket.display().to_string())
}
fn read_output(mut file: File, limit: u64) -> Result<Vec<u8>> {
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(0)).map_err(err)?;
    let mut bytes = vec![];
    file.take(limit + 1).read_to_end(&mut bytes).map_err(err)?;
    if bytes.len() as u64 > limit {
        return Err("Git output exceeds the import size limit".into());
    }
    Ok(bytes)
}
fn directory_size(root: &Path) -> Result<u64> {
    let mut pending = vec![root.to_path_buf()];
    let mut bytes = 0;
    let mut count = 0;
    while let Some(path) = pending.pop() {
        for entry in fs::read_dir(path).map_err(err)? {
            let entry = entry.map_err(err)?;
            count += 1;
            if count > MAX_ENTRIES {
                return Err("Repository exceeds the import entry limit".into());
            }
            let meta = match entry.metadata() {
                Ok(meta) => meta,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(err(e)),
            };
            if meta.is_dir() {
                pending.push(entry.path());
            } else {
                bytes += meta.len();
            }
            if bytes > MAX_REPO_BYTES {
                return Ok(bytes);
            }
        }
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn uploaded(files: &[(&str, &str)]) -> FolderUpload {
        FolderUpload {
            source: "example".into(),
            files: files
                .iter()
                .map(|(path, text)| ImportFile {
                    path: (*path).into(),
                    text: Some((*text).into()),
                    base64: None,
                })
                .collect(),
        }
    }

    #[test]
    fn dropped_folder_uses_reviewed_snapshot_without_a_temporary_reload_source() {
        let prepared = prepare_upload(uploaded(&[
            (
                "dist/manifest.json",
                r#"{"id":"example.drop","name":"Drop","apiVersion":1}"#,
            ),
            ("dist/plugin.js", "export function apply() {}"),
        ]))
        .unwrap();
        assert_eq!(prepared.preview.source, "Dropped folder: example");
        assert_eq!(prepared.preview.candidates[0].path, "dist");
        assert!(prepared.folder_root.is_none());
        let home = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
        let installed = prepared
            .install(&manager, &prepared.preview.token, "dist")
            .unwrap();
        let plugin = installed
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.drop")
            .unwrap();
        assert!(!plugin.enabled);
        assert!(!plugin.reloadable);
        assert!(plugin.update_source.is_none());
        manager.change("enable", "example.drop").unwrap();
        assert_eq!(
            manager.module("example.drop", &plugin.revision).unwrap(),
            "export function apply() {}"
        );
    }

    #[test]
    fn dropped_folder_rejects_escaping_duplicate_and_oversized_inputs() {
        for path in [
            "../plugin.js",
            "/plugin.js",
            "a/../../plugin.js",
            "C:/plugin.js",
            "a\\plugin.js",
            "a//plugin.js",
            "a/./plugin.js",
            "other.txt",
        ] {
            assert!(prepare_upload(uploaded(&[(path, "")])).is_err(), "{path}");
        }
        assert!(prepare_upload(uploaded(&[("plugin.js", ""), ("plugin.js", "")])).is_err());
        let large = "x".repeat(LIMIT as usize + 1);
        assert!(prepare_upload(uploaded(&[("plugin.js", &large)])).is_err());
    }

    #[test]
    fn dropped_folder_does_not_fall_back_from_an_incomplete_signed_pair() {
        let prepared = prepare_upload(uploaded(&[
            (
                "manifest.json",
                r#"{"id":"example.drop","name":"Drop","apiVersion":1}"#,
            ),
            ("plugin.js", "export {}"),
            ("plugin.artifact.json", "{}"),
        ]))
        .unwrap();
        assert!(prepared.preview.candidates.is_empty());
        assert!(prepared.preview.warnings[0].contains("Incomplete signed plugin release pair"));
    }

    fn decode_content_icon(encoded: Option<&str>) -> Option<Vec<u8>> {
        use base64::Engine as _;
        encoded.map(|value| {
            base64::engine::general_purpose::STANDARD
                .decode(value)
                .unwrap()
        })
    }
    use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder as _};
    fn png() -> Vec<u8> {
        let mut bytes = vec![];
        PngEncoder::new(&mut bytes)
            .write_image(&[0, 0, 0, 0], 1, 1, ExtendedColorType::Rgba8)
            .unwrap();
        bytes
    }
    #[test]
    fn dropped_assets_match_folder_package_and_survive_install() {
        let root = tempfile::tempdir().unwrap();
        let package = plugin(root.path(), "dist", "example.assets");
        let png = png();
        let mut jpg = vec![];
        image::codecs::jpeg::JpegEncoder::new(&mut jpg)
            .write_image(&[128, 128, 128], 1, 1, ExtendedColorType::Rgb8)
            .unwrap();
        fs::write(package.join("README.md"), "# Hello").unwrap();
        fs::write(package.join("icon.png"), &png).unwrap();
        fs::write(package.join("icon.jpg"), &jpg).unwrap();
        let folder = prepare_folder(&package).unwrap();
        let mut upload = uploaded(&[
            (
                "manifest.json",
                &fs::read_to_string(package.join("manifest.json")).unwrap(),
            ),
            (
                "plugin.js",
                &fs::read_to_string(package.join("plugin.js")).unwrap(),
            ),
            ("README.md", "# Hello"),
        ]);
        for (name, bytes) in [("icon.png", &png), ("icon.jpg", &jpg)] {
            upload.files.push(ImportFile {
                path: name.into(),
                text: None,
                base64: Some(BASE64.encode(bytes)),
            });
        }
        let dropped = prepare_upload(upload).unwrap();
        assert!(dropped.preview.warnings.is_empty());
        let candidate = &dropped.preview.candidates[0];
        assert_eq!(candidate.revision, folder.preview.candidates[0].revision);
        let home = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
        dropped
            .install(&manager, &dropped.preview.token, ".")
            .unwrap();
        let content = manager
            .content("example.assets", &candidate.revision)
            .unwrap();
        assert_eq!(content.readme.as_deref(), Some("# Hello"));
        assert_eq!(decode_content_icon(content.icon_png.as_deref()), Some(png));
        assert_eq!(decode_content_icon(content.icon_jpg.as_deref()), Some(jpg));
    }

    #[test]
    fn dropped_assets_reject_invalid_encodings_and_enforce_asset_limits() {
        for (path, text, base64) in [
            ("icon.png", None, Some("!".into())),
            ("icon.png", Some("text".into()), Some("AA==".into())),
            ("icon.png", None, None),
            ("plugin.js", None, Some("AA==".into())),
            ("README.md", Some("x".repeat(MAX_README_BYTES + 1)), None),
            (
                "icon.jpg",
                None,
                Some(BASE64.encode(vec![0; MAX_ICON_BYTES + 1])),
            ),
        ] {
            assert!(
                prepare_upload(FolderUpload {
                    source: "invalid".into(),
                    files: vec![ImportFile {
                        path: path.into(),
                        text,
                        base64
                    }],
                })
                .is_err(),
                "{path}"
            );
        }
        // Valid base64 still has to pass the package's real image validator.
        let mut invalid = uploaded(&[
            (
                "manifest.json",
                r#"{"id":"example.invalid","name":"Invalid","apiVersion":1}"#,
            ),
            ("plugin.js", "export {}"),
        ]);
        invalid.files.push(ImportFile {
            path: "icon.png".into(),
            text: None,
            base64: Some("AA==".into()),
        });
        let prepared = prepare_upload(invalid).unwrap();
        assert!(prepared.preview.candidates.is_empty());
        assert_eq!(prepared.preview.warnings.len(), 1);
    }

    fn plugin(root: &Path, folder: &str, id: &str) -> PathBuf {
        let path = root.join(folder);
        fs::create_dir_all(&path).unwrap();
        fs::write(
            path.join("manifest.json"),
            format!(r#"{{"id":"{id}","name":"{id}","apiVersion":1}}"#),
        )
        .unwrap();
        fs::write(
            path.join("plugin.js"),
            "export function apply() {} // first",
        )
        .unwrap();
        path
    }
    #[test]
    fn source_parent_and_matching_build_are_one_discovery_across_import_sources() {
        let git = Git::new().unwrap();
        git.run(&["init", "--template=", "repository"], LIMIT)
            .unwrap();
        let repo = git.scratch.path().join("repository");
        plugin(&repo, "", "example.one");
        fs::remove_file(repo.join("plugin.js")).unwrap();
        plugin(&repo, "dist", "example.one");
        let broken = plugin(&repo, "broken", "example.one");
        fs::remove_file(broken.join("plugin.js")).unwrap();
        let other = plugin(&repo, "other", "example.other");
        fs::remove_file(other.join("plugin.js")).unwrap();
        plugin(&repo, "other/dist", "example.different");
        fs::create_dir_all(repo.join("malformed")).unwrap();
        fs::write(repo.join("malformed/manifest.json"), "{}").unwrap();
        plugin(&repo, "malformed/dist", "example.one");
        let paths = [
            "manifest.json",
            "dist/manifest.json",
            "dist/plugin.js",
            "broken/manifest.json",
            "other/manifest.json",
            "other/dist/manifest.json",
            "other/dist/plugin.js",
            "malformed/manifest.json",
            "malformed/dist/manifest.json",
            "malformed/dist/plugin.js",
        ];
        let upload = FolderUpload {
            source: "fixture".into(),
            files: paths
                .iter()
                .map(|path| ImportFile {
                    path: (*path).into(),
                    text: Some(fs::read_to_string(repo.join(path)).unwrap()),
                    base64: None,
                })
                .collect(),
        };
        git.run(&["-C", "repository", "add", "."], LIMIT).unwrap();
        git.run(
            &[
                "-C",
                "repository",
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "fixture",
            ],
            LIMIT,
        )
        .unwrap();
        for prepared in [
            prepare_folder(&repo).unwrap(),
            prepare_upload(upload).unwrap(),
            git.read_plugins("fixture".into(), None).unwrap(),
        ] {
            assert_eq!(prepared.preview.candidates.len(), 3);
            assert_eq!(prepared.preview.warnings.len(), 3);
            for folder in ["broken:", "other:", "malformed:"] {
                assert!(prepared
                    .preview
                    .warnings
                    .iter()
                    .any(|warning| warning.starts_with(folder)));
            }
        }
        // With no valid build, a source-only manifest still explains why import failed.
        fs::remove_file(repo.join("dist/plugin.js")).unwrap();
        fs::remove_file(repo.join("malformed/dist/plugin.js")).unwrap();
        let missing = prepare_folder(&repo).unwrap();
        assert!(missing
            .preview
            .warnings
            .iter()
            .any(|warning| warning.starts_with("Selected folder:")));
    }

    #[test]
    fn folder_discovers_nested_dist_and_installs_exact_preview_without_execution() {
        let root = tempfile::tempdir().unwrap();
        let source = plugin(root.path(), "pages/one/dist", "example.one");
        fs::write(source.join("README.md"), "# One").unwrap();
        fs::write(source.join("icon.png"), png()).unwrap();
        plugin(root.path(), "panels/two", "example.two");
        plugin(root.path(), "node_modules/skipped", "example.skipped");
        fs::write(root.path().join("manifest.json"), "{}").unwrap();
        let prepared = prepare_folder(root.path()).unwrap();
        assert_eq!(prepared.preview.candidates.len(), 2);
        assert_eq!(prepared.preview.candidates[0].path, "pages/one/dist");
        assert!(prepared.preview.candidates[0].readme_revision.is_some());
        assert!(prepared.preview.candidates[0].icon_png_revision.is_some());
        assert_eq!(
            prepared.preview.warnings,
            ["Selected folder: Missing file: plugin.js"]
        );
        let home = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
        assert!(prepared
            .install(&manager, "wrong", "pages/one/dist")
            .is_err());
        assert!(prepared
            .install(&manager, &prepared.preview.token, "../escape")
            .is_err());
        fs::write(
            source.join("plugin.js"),
            "throw Error('changed'); while(true) {}",
        )
        .unwrap();
        let catalog = prepared
            .install(&manager, &prepared.preview.token, "pages/one/dist")
            .unwrap();
        let installed = catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.one")
            .unwrap();
        assert!(!installed.enabled);
        let content = manager.content("example.one", &installed.revision).unwrap();
        assert_eq!(content.readme.as_deref(), Some("# One"));
        assert_eq!(
            decode_content_icon(content.icon_png.as_deref()).as_deref(),
            Some(png().as_slice())
        );
        manager.change("enable", "example.one").unwrap();
        assert!(manager
            .module("example.one", &installed.revision)
            .unwrap()
            .contains("first"));
        // Repeating the exact preview is idempotent; update/rollback retain ordinary semantics.
        let again = prepared
            .install(&manager, &prepared.preview.token, "pages/one/dist")
            .unwrap();
        assert!(again
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.one")
            .unwrap()
            .previous
            .is_none());
        let update = prepare_folder(root.path()).unwrap();
        let next = update
            .install(&manager, &update.preview.token, "pages/one/dist")
            .unwrap();
        let installed = next
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.one")
            .unwrap();
        assert!(installed.enabled);
        assert!(installed.previous.is_some());
    }
    #[test]
    fn remembered_sources_follow_revision_updates_rollback_and_reopen() {
        let root = tempfile::tempdir().unwrap();
        let source = plugin(root.path(), "dist", "example.remembered");
        let home = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
        let folder = prepare_folder(root.path()).unwrap();
        let first = folder
            .install(&manager, &folder.preview.token, "dist")
            .unwrap();
        let first = first
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.remembered")
            .unwrap();
        let folder_source = first.update_source.clone();
        assert!(first.reloadable);
        // The serialized folder shape is unchanged, so pre-existing registry entries still read.
        let old_shape =
            serde_json::json!({"root": root.path().canonicalize().unwrap(), "path": "dist"});
        assert_eq!(
            serde_json::from_value::<InstallSource>(old_shape).unwrap(),
            folder_source.clone().unwrap()
        );
        manager.change("enable", "example.remembered").unwrap();
        fs::write(source.join("plugin.js"), "export const updated = true;").unwrap();
        let mut git = prepare_folder(root.path()).unwrap();
        git.folder_root = None;
        git.git_source = Some(GitSource {
            repository: "https://example.com/plugins".into(),
            reference: "release/one".into(),
            path: ".".into(),
            commit: None,
        });
        let next = git.install(&manager, &git.preview.token, "dist").unwrap();
        let next = next
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.remembered")
            .unwrap();
        assert!(next.enabled);
        assert!(!next.reloadable);
        let git_source = Some(InstallSource::Git(GitSource {
            repository: "https://example.com/plugins".into(),
            reference: "release/one".into(),
            path: "dist".into(),
            commit: None,
        }));
        assert_eq!(next.update_source, git_source);
        let reopened = Manager::open(Some(home.path().into()), "test", false).unwrap();
        let catalog = reopened.catalog().unwrap();
        assert_eq!(
            catalog
                .plugins
                .iter()
                .find(|p| p.manifest.id == "example.remembered")
                .unwrap()
                .update_source,
            git_source
        );
        assert!(reopened
            .reload_live("example.remembered")
            .err()
            .unwrap()
            .contains("reloadable folder"));
        let rolled = reopened.change("rollback", "example.remembered").unwrap();
        let rolled = rolled
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.remembered")
            .unwrap();
        assert!(rolled.enabled);
        assert!(rolled.reloadable);
        assert_eq!(rolled.update_source, folder_source);
        assert!(rolled.previous.is_none());
        assert!(reopened
            .change("rollback", "example.remembered")
            .err()
            .unwrap()
            .contains("No previous revision"));
        // Updating again creates a new rollback target and remembers the Git source again.
        let updated = git.install(&reopened, &git.preview.token, "dist").unwrap();
        let updated = updated
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.remembered")
            .unwrap();
        assert!(updated.previous.is_some());
        assert_eq!(updated.update_source, git_source);
    }
    #[test]
    fn git_sources_record_the_installed_commit_and_still_read_without_one() {
        let legacy = serde_json::json!({
            "repository": "https://example.com/plugins",
            "reference": "main",
            "path": "dist"
        });
        let parsed: InstallSource = serde_json::from_value(legacy.clone()).unwrap();
        assert!(matches!(
            &parsed,
            InstallSource::Git(GitSource { commit: None, .. })
        ));
        assert_eq!(serde_json::to_value(&parsed).unwrap(), legacy);

        let commit = "a".repeat(40);
        let root = tempfile::tempdir().unwrap();
        plugin(root.path(), "dist", "example.pinned");
        let mut git = prepare_folder(root.path()).unwrap();
        git.folder_root = None;
        git.git_source = Some(GitSource {
            repository: "https://example.com/plugins".into(),
            reference: "main".into(),
            path: ".".into(),
            commit: Some(commit.clone()),
        });
        let home = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
        let catalog = git.install(&manager, &git.preview.token, "dist").unwrap();
        let installed = catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.pinned")
            .unwrap();
        let Some(InstallSource::Git(source)) = &installed.update_source else {
            panic!("expected a Git source");
        };
        assert_eq!(source.commit.as_deref(), Some(commit.as_str()));
        assert_eq!(source.path, "dist");
    }
    #[test]
    fn folder_skips_hidden_descendants_but_accepts_a_hidden_selection() {
        let root = tempfile::tempdir().unwrap();
        plugin(root.path(), "", "example.root");
        plugin(root.path(), "dist", "example.root");
        plugin(root.path(), ".cache/built", "example.root");
        let worktree = plugin(root.path(), ".claude/worktrees/feature", "example.root");
        plugin(&worktree, "dist", "example.root");
        let paths = |directory: &Path| {
            prepare_folder(directory)
                .unwrap()
                .preview
                .candidates
                .into_iter()
                .map(|candidate| candidate.path)
                .collect::<Vec<_>>()
        };
        assert_eq!(paths(root.path()), [".", "dist"]);
        assert_eq!(
            paths(&root.path().join(".claude")),
            ["worktrees/feature", "worktrees/feature/dist"]
        );
    }
    #[cfg(unix)]
    #[test]
    fn folder_and_git_optional_assets_require_exact_names_and_regular_files() {
        let git = Git::new().unwrap();
        git.run(&["init", "--template=", "repository"], LIMIT)
            .unwrap();
        let repo = git.scratch.path().join("repository");
        let case = plugin(&repo, "case", "example.case");
        fs::write(case.join("readme.md"), "not conventional").unwrap();
        for (index, name) in ["README.md", "icon.png", "icon.jpg"].iter().enumerate() {
            let linked = plugin(
                &repo,
                &format!("linked{index}"),
                &format!("example.linked{index}"),
            );
            std::os::unix::fs::symlink("plugin.js", linked.join(name)).unwrap();
        }
        git.run(&["-C", "repository", "add", "."], LIMIT).unwrap();
        git.run(
            &[
                "-C",
                "repository",
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "fixture",
            ],
            LIMIT,
        )
        .unwrap();
        let folder = prepare_folder(&repo).unwrap();
        let committed = git.read_plugins("fixture".into(), None).unwrap();
        for prepared in [folder, committed] {
            assert_eq!(prepared.preview.candidates.len(), 1);
            assert_eq!(prepared.preview.warnings.len(), 3);
            let candidate = &prepared.preview.candidates[0];
            assert_eq!(candidate.path, "case");
            assert!(candidate.readme_revision.is_none());
            assert!(candidate.icon_png_revision.is_none());
            assert!(candidate.icon_jpg_revision.is_none());
        }
    }
    #[cfg(unix)]
    #[test]
    fn folder_never_follows_symlinks_or_reads_special_files() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        plugin(outside.path(), "outside", "example.outside");
        symlink(outside.path(), root.path().join("escape")).unwrap();
        let folder = plugin(root.path(), "bad", "example.bad");
        fs::remove_file(folder.join("plugin.js")).unwrap();
        symlink(
            outside.path().join("outside/plugin.js"),
            folder.join("plugin.js"),
        )
        .unwrap();
        let fifo = plugin(root.path(), "fifo", "example.fifo");
        fs::remove_file(fifo.join("plugin.js")).unwrap();
        let name =
            std::ffi::CString::new(fifo.join("plugin.js").as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let prepared = prepare_folder(root.path()).unwrap();
        assert!(prepared.preview.candidates.is_empty());
        assert_eq!(prepared.preview.warnings.len(), 2);
    }
    #[cfg(unix)]
    #[test]
    fn folder_identity_is_lossless_and_capability_rejects_replaced_ancestors() {
        use std::os::unix::{ffi::OsStringExt, fs::symlink};
        let root = tempfile::tempdir().unwrap();
        plugin(root.path(), "a\\b", "example.backslash");
        plugin(root.path(), "a/b", "example.slash");
        let prepared = prepare_folder(root.path()).unwrap();
        assert_eq!(prepared.preview.candidates.len(), 2);
        assert_eq!(prepared.artifacts.len(), 2);
        let home = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
        for candidate in &prepared.preview.candidates {
            let catalog = prepared
                .install(&manager, &prepared.preview.token, &candidate.path)
                .unwrap();
            assert!(catalog.plugins.iter().any(
                |p| p.manifest.id == candidate.manifest.id && p.revision == candidate.revision
            ));
        }
        let outside = tempfile::tempdir().unwrap();
        plugin(outside.path(), "b", "example.outside");
        let directory =
            cap_std::fs::Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        fs::rename(root.path().join("a"), root.path().join("old-a")).unwrap();
        symlink(outside.path(), root.path().join("a")).unwrap();
        assert!(read_source_file(&directory, Path::new("a/b/plugin.js")).is_err());
        let invalid = root
            .path()
            .join(std::ffi::OsString::from_vec(vec![b'p', 0xff]));
        // macOS filesystems reject invalid UTF-8 names at creation; exercise the production
        // key conversion directly so this check is meaningful on Linux and macOS.
        assert!(candidate_path(&invalid).is_err());
    }
    #[test]
    fn rejects_invalid_artifacts_and_bounds_preview_size() {
        let root = tempfile::tempdir().unwrap();
        plugin(root.path(), "bundled", "buzz.channels");
        let bad = plugin(root.path(), "unsupported", "example.bad");
        fs::write(
            bad.join("manifest.json"),
            r#"{"id":"example.bad","name":"Bad","apiVersion":2}"#,
        )
        .unwrap();
        let empty = plugin(root.path(), "empty", "example.empty");
        fs::write(empty.join("plugin.js"), " ").unwrap();
        let large = plugin(root.path(), "large", "example.large");
        File::create(large.join("plugin.js"))
            .unwrap()
            .set_len(LIMIT + 1)
            .unwrap();
        let prepared = prepare_folder(root.path()).unwrap();
        assert!(prepared.preview.candidates.is_empty());
        assert_eq!(prepared.preview.warnings.len(), 4);
        for n in 0..=MAX_PLUGINS {
            plugin(root.path(), &format!("many/{n}"), &format!("example.p{n}"));
        }
        assert!(prepare_folder(root.path()).is_err());
    }
    #[test]
    fn accepts_explicit_transports_and_github_shorthand_only() {
        assert_eq!(
            repository_url("block/plugins").unwrap(),
            "https://github.com/block/plugins"
        );
        assert_eq!(
            repository_url("git@github.com:block/plugins.git").unwrap(),
            "ssh://git@github.com/block/plugins.git"
        );
        assert_eq!(
            repository_url("org-49461806@github.com:squareup/buzz-context-manager.git").unwrap(),
            "ssh://org-49461806@github.com/squareup/buzz-context-manager.git"
        );
        assert_eq!(
            repository_url("dev.user@git.example.org:team/repo.git").unwrap(),
            "ssh://dev.user@git.example.org/team/repo.git"
        );
        assert!(repository_url("https://git.example.org/team/repo.git").is_ok());
        for input in [
            "/tmp/repo",
            "file:///tmp/repo",
            "ext::sh -c bad",
            "git://example.com/repo",
            "https://me:secret@example.com/repo",
            "https://example.com/repo?token=secret",
            "https://github.com/block/repo/tree/main/plugins",
            "https://www.github.com/block/repo/tree/main/plugins",
            "https://github.com./block/repo/tree/main/plugins",
            "https://git%68ub.com/block/repo",
            "ssh://git@exa%6dple.com/team/repo",
            "--upload-pack=bad",
            "ssh://-oProxyCommand=bad/repo",
            "-oProxyCommand=bad@github.com:owner/repo.git",
            "user@-host:owner/repo.git",
            "user@github.com:owner/repo.git?token=secret",
            "user@github.com:owner/repo.git#fragment",
            "user@github.com:owner/repo.git extra",
            "/tmp/user@github.com:owner/repo.git",
            "user@github.com:",
        ] {
            assert!(repository_url(input).is_err(), "{input}");
        }
        assert!(prepare_git("block/plugins", "--upload-pack=bad", None).is_err());
    }
    #[test]
    fn required_commits_are_validated_before_any_git_work() {
        for valid in ["a".repeat(40), "A".repeat(40), "0123456789abcdef".repeat(4)] {
            assert!(RequiredCommit::parse(&valid).is_ok(), "{valid}");
        }
        for invalid in [
            "",
            "main",
            "abc123",
            &"a".repeat(39),
            &"a".repeat(41),
            &"a".repeat(63),
            &"a".repeat(65),
            &"g".repeat(40),
            " ".repeat(40).as_str(),
        ] {
            let error = RequiredCommit::parse(invalid).err().unwrap();
            assert!(error.contains("40 or 64 digit"), "{invalid:?}");
        }
    }
    #[test]
    fn only_pinned_imports_record_the_installed_commit() {
        let head = "a".repeat(40);
        let url = "https://github.com/acme/plugins".to_owned();
        let pinned = git_source(
            url.clone(),
            "v1",
            Some(RequiredCommit::parse(&head).unwrap()),
            Some(&head),
        );
        assert_eq!(pinned.commit.as_deref(), Some(head.as_str()));
        let unpinned = git_source(url, "v1", None, Some(&head));
        assert_eq!(unpinned.commit, None);
        assert!(!serde_json::to_string(&unpinned).unwrap().contains("commit"));
    }
    #[test]
    fn pins_match_full_object_ids_of_either_hash_length() {
        let commit = |git: &Git| {
            git.run(&["-C", "repository", "add", "."], LIMIT).unwrap();
            git.run(
                &[
                    "-C",
                    "repository",
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "-m",
                    "fixture",
                ],
                LIMIT,
            )
            .unwrap();
        };
        for (format, length) in [("sha1", 40), ("sha256", 64)] {
            let git = Git::new().unwrap();
            git.run(
                &[
                    "init",
                    "--template=",
                    &format!("--object-format={format}"),
                    "repository",
                ],
                LIMIT,
            )
            .unwrap();
            plugin(
                &git.scratch.path().join("repository"),
                "dist",
                "example.one",
            );
            commit(&git);
            let head = git
                .read_plugins("fixture".into(), None)
                .unwrap()
                .preview
                .commit
                .unwrap();
            assert_eq!(head.len(), length, "{format}");
            assert!(git.read_plugins("fixture".into(), Some(&head)).is_ok());
            assert!(git
                .read_plugins("fixture".into(), Some(&head.to_uppercase()))
                .is_ok());
            let other = if length == 40 { 64 } else { 40 };
            let lookalike = if length == 64 {
                head[..40].to_owned()
            } else {
                format!("{head}{}", "0".repeat(24))
            };
            for wrong in [lookalike, "0".repeat(other)] {
                let refused = git.read_plugins("fixture".into(), Some(&wrong));
                assert!(
                    refused.err().unwrap().contains("not the required commit"),
                    "{format} {wrong}"
                );
            }
        }
    }
    #[test]
    fn git_reads_committed_blobs_without_checkout_filters_symlinks_or_scripts() {
        let git = Git::new().unwrap();
        git.run(&["init", "--template=", "repository"], LIMIT)
            .unwrap();
        let repo = git.scratch.path().join("repository");
        let signed = plugin(&repo, "plugins/one/dist", "example.one");
        crate::sign_release(&signed, &nostr::key::SecretKey::generate().to_secret_hex()).unwrap();
        fs::remove_file(signed.join("manifest.json")).unwrap();
        fs::remove_file(signed.join("plugin.js")).unwrap();
        plugin(&repo, "plugins/two", "example.two");
        fs::write(repo.join("plugins/two/README.md"), "# Two").unwrap();
        fs::write(repo.join("plugins/two/icon.png"), png()).unwrap();
        let mut jpg = vec![];
        image::codecs::jpeg::JpegEncoder::new(&mut jpg)
            .write_image(&[128, 128, 128], 1, 1, ExtendedColorType::Rgb8)
            .unwrap();
        fs::write(repo.join("plugins/two/icon.jpg"), &jpg).unwrap();
        fs::write(
            repo.join("package.json"),
            r#"{"scripts":{"postinstall":"exit 1"}}"#,
        )
        .unwrap();
        fs::write(repo.join(".gitattributes"), "*.js filter=must-not-run").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc", repo.join("outside")).unwrap();
        git.run(&["-C", "repository", "add", "."], LIMIT).unwrap();
        git.run(
            &[
                "-C",
                "repository",
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "fixture",
            ],
            LIMIT,
        )
        .unwrap();
        fs::write(
            repo.join("plugins/one/dist/plugin.js"),
            "uncommitted change",
        )
        .unwrap();
        let prepared = git.read_plugins("fixture".into(), None).unwrap();
        let head = prepared.preview.commit.clone().unwrap();
        assert!(git
            .read_plugins("fixture".into(), Some(&head.to_uppercase()))
            .is_ok());
        let refused = git
            .read_plugins("fixture".into(), Some(&"0".repeat(40)))
            .err()
            .unwrap();
        assert!(refused.contains(&head) && refused.contains("not the required commit"));
        assert_eq!(prepared.preview.candidates.len(), 2);
        assert!(prepared
            .preview
            .candidates
            .iter()
            .find(|candidate| candidate.path == "plugins/one/dist")
            .unwrap()
            .publisher
            .is_some());
        let with_assets = prepared
            .preview
            .candidates
            .iter()
            .find(|candidate| candidate.path == "plugins/two")
            .unwrap();
        assert!(with_assets.readme_revision.is_some());
        assert!(with_assets.icon_png_revision.is_some());
        assert!(with_assets.icon_jpg_revision.is_some());
        assert_eq!(prepared.preview.commit.as_ref().unwrap().len(), 40);
        let text = String::from_utf8(prepared.artifacts["plugins/one/dist"].bytes.clone()).unwrap();
        assert!(text.contains("first"));
        assert!(!text.contains("uncommitted"));
        let home = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
        let catalog = prepared
            .install(&manager, &prepared.preview.token, "plugins/one/dist")
            .unwrap();
        let installed = catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.one")
            .unwrap();
        manager.change("enable", "example.one").unwrap();
        assert!(manager
            .module("example.one", &installed.revision)
            .unwrap()
            .contains("first"));
        prepared
            .install(&manager, &prepared.preview.token, "plugins/two")
            .unwrap();
        let content = manager
            .content("example.two", &with_assets.revision)
            .unwrap();
        assert_eq!(
            decode_content_icon(content.icon_jpg.as_deref()).as_deref(),
            Some(jpg.as_slice())
        );
        assert_eq!(
            decode_content_icon(content.icon_png.as_deref()).as_deref(),
            Some(png().as_slice())
        );
    }
    #[test]
    fn saved_folder_checks_preserve_install_and_other_previews() {
        let root = tempfile::tempdir().unwrap();
        let source = plugin(root.path(), "dist", "example.checked");
        let home = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
        let pending = prepare_folder(root.path()).unwrap();
        let installed = pending
            .install(&manager, &pending.preview.token, "dist")
            .unwrap();
        let original = installed
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.checked")
            .unwrap()
            .revision
            .clone();
        assert_eq!(
            check_saved_folder(&manager, "example.checked").unwrap(),
            original
        );
        fs::write(
            source.join("plugin.js"),
            "export function activate() { /* changed */ }",
        )
        .unwrap();
        assert_ne!(
            check_saved_folder(&manager, "example.checked").unwrap(),
            original
        );
        // A read never installs bytes or invalidates an unrelated captured preview.
        let current = manager.catalog().unwrap();
        assert_eq!(
            current
                .plugins
                .iter()
                .find(|p| p.manifest.id == "example.checked")
                .unwrap()
                .revision,
            original
        );
        pending
            .install(&manager, &pending.preview.token, "dist")
            .unwrap();
        assert!(check_saved_folder(&manager, "missing").is_err());
        assert!(check_saved_folder(&manager, "buzz.channels").is_err());
    }

    #[test]
    fn saved_folder_checks_report_build_errors_and_do_not_substitute_siblings() {
        let root = tempfile::tempdir().unwrap();
        let source = plugin(root.path(), "dist", "example.checked");
        let home = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
        let pending = prepare_folder(root.path()).unwrap();
        pending
            .install(&manager, &pending.preview.token, "dist")
            .unwrap();
        plugin(root.path(), "other", "example.checked");
        let bound = prepare_saved_folder(&manager, "example.checked").unwrap();
        assert_eq!(bound.preview.candidates.len(), 1);
        assert!(bound
            .install(&manager, &bound.preview.token, "other")
            .is_err());
        fs::remove_file(source.join("plugin.js")).unwrap();
        let error = check_saved_folder(&manager, "example.checked").unwrap_err();
        assert!(error.contains("dist:"), "{error}");
        assert!(error.contains("plugin.js"), "{error}");
    }

    #[test]
    fn signed_folder_import_load_reload_and_publisher_continuity() {
        let root = tempfile::tempdir().unwrap();
        let source = plugin(root.path(), "dist", "example.signed");
        let first_key = nostr::key::SecretKey::generate().to_secret_hex();
        let publisher = crate::sign_release(&source, &first_key).unwrap();
        let pair_only = tempfile::tempdir().unwrap();
        for name in ["plugin.artifact.json", "plugin.signature.json"] {
            fs::copy(source.join(name), pair_only.path().join(name)).unwrap();
        }
        assert_eq!(
            prepare_folder(pair_only.path())
                .unwrap()
                .preview
                .candidates
                .len(),
            1
        );
        let prepared = prepare_folder(root.path()).unwrap();
        assert_eq!(
            prepared.preview.candidates[0].publisher.as_deref(),
            Some(publisher.as_str())
        );
        let home = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
        let installed = prepared
            .install(&manager, &prepared.preview.token, "dist")
            .unwrap();
        let first = installed
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.signed")
            .unwrap();
        assert_eq!(first.publisher.as_deref(), Some(publisher.as_str()));
        let first_revision = first.revision.clone();
        manager.change("enable", "example.signed").unwrap();
        assert!(manager
            .module("example.signed", &first_revision)
            .unwrap()
            .contains("first"));
        let stored = manager.artifact_path("example.signed", &first_revision);
        let original = fs::read(&stored).unwrap();
        fs::write(&stored, b"{}").unwrap();
        assert!(manager.module("example.signed", &first_revision).is_err());
        fs::write(&stored, original).unwrap();
        manager.change("disable", "example.signed").unwrap();
        fs::write(source.join("plugin.js"), "export const changed = true;").unwrap();
        crate::sign_release(&source, &first_key).unwrap();
        let second = manager.reload("example.signed").unwrap();
        let second = second
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.signed")
            .unwrap();
        assert_eq!(second.publisher.as_deref(), Some(publisher.as_str()));
        manager.change("enable", "example.signed").unwrap();
        assert!(manager
            .module("example.signed", &second.revision)
            .unwrap()
            .contains("changed"));
        manager.change("disable", "example.signed").unwrap();
        manager.change("rollback", "example.signed").unwrap();
        assert_eq!(
            manager
                .catalog()
                .unwrap()
                .plugins
                .iter()
                .find(|p| p.manifest.id == "example.signed")
                .unwrap()
                .publisher
                .as_deref(),
            Some(publisher.as_str())
        );
        manager.change("enable", "example.signed").unwrap();
        assert!(manager
            .module("example.signed", &first_revision)
            .unwrap()
            .contains("first"));
        manager.change("disable", "example.signed").unwrap();
        crate::sign_release(&source, &nostr::key::SecretKey::generate().to_secret_hex()).unwrap();
        let different = prepare_folder(root.path()).unwrap();
        assert!(different
            .install(&manager, &different.preview.token, "dist")
            .err()
            .unwrap()
            .contains("Publisher changed"));
        assert!(manager
            .reload("example.signed")
            .err()
            .unwrap()
            .contains("Publisher changed"));
        fs::remove_file(source.join("plugin.artifact.json")).unwrap();
        fs::remove_file(source.join("plugin.signature.json")).unwrap();
        assert!(manager
            .install(&source)
            .err()
            .unwrap()
            .contains("Publisher changed"));
        manager.change("remove", "example.signed").unwrap();
        assert!(manager.install(&source).is_ok());
    }
    #[test]
    fn signed_pair_never_falls_back_to_unsigned_files() {
        let root = tempfile::tempdir().unwrap();
        let source = plugin(root.path(), "dist", "example.signed");
        crate::sign_release(&source, &nostr::key::SecretKey::generate().to_secret_hex()).unwrap();
        fs::remove_file(source.join("plugin.signature.json")).unwrap();
        let preview = prepare_folder(root.path()).unwrap();
        assert!(preview.preview.candidates.is_empty());
        assert!(preview.preview.warnings[0].contains("Incomplete signed"));
        fs::write(source.join("plugin.signature.json"), "{}").unwrap();
        assert!(prepare_folder(root.path())
            .unwrap()
            .preview
            .candidates
            .is_empty());
    }
    #[test]
    fn signed_update_cannot_roll_back_to_unsigned_revision() {
        let root = tempfile::tempdir().unwrap();
        let source = plugin(root.path(), "dist", "example.signed");
        let home = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
        manager.install(&source).unwrap();
        fs::write(source.join("plugin.js"), "export const signed = true;").unwrap();
        crate::sign_release(&source, &nostr::key::SecretKey::generate().to_secret_hex()).unwrap();
        manager.install(&source).unwrap();
        assert!(manager
            .change("rollback", "example.signed")
            .err()
            .unwrap()
            .contains("unsigned"));
    }
    #[test]
    fn authorization_reaches_only_its_repository_and_never_follows_a_redirect() {
        use std::io::{BufRead, BufReader, Write};
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.local_addr().unwrap());
        let requests = thread::spawn(move || {
            let mut seen = vec![];
            for _ in 0..2 {
                let (stream, _) = server.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut head = vec![];
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line.trim().is_empty() {
                        break;
                    }
                    head.push(line.trim().to_string());
                }
                // Each repository redirects; Git must report it, not follow it with the header.
                let mut stream = stream;
                write!(stream, "HTTP/1.1 302 Found\r\nLocation: /elsewhere/info/refs?service=git-upload-pack\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                seen.push(head);
            }
            seen
        });
        let mut git = Git::new().unwrap();
        let repository = format!("{base}/git/{}/plugin", "a".repeat(64));
        git.authorization = Some((repository.clone(), "dG9rZW4=".into()));
        git.federated_header = Some("Bearer fixture-assertion".into());
        for url in [
            repository,
            format!("{base}/git/{}/plugin-other", "a".repeat(64)),
        ] {
            let error = git
                .run(
                    &["-c", "protocol.http.allow=always", "ls-remote", "--", &url],
                    LIMIT,
                )
                .unwrap_err();
            assert_eq!(error, "Git could not read the protected repository");
        }
        let seen = requests.join().unwrap();
        let authorization = |head: &Vec<String>| {
            head.iter()
                .any(|line| line == "Authorization: Nostr dG9rZW4=")
        };
        assert!(seen[0][0].contains("/plugin/info/refs"), "{:?}", seen[0]);
        assert!(authorization(&seen[0]));
        assert_eq!(
            seen[0]
                .iter()
                .filter(|line| *line == "Nostr-Federated-Identity: Bearer fixture-assertion")
                .count(),
            1
        );
        // A sibling whose name shares the prefix is a different repository.
        assert!(
            seen[1][0].contains("/plugin-other/info/refs"),
            "{:?}",
            seen[1]
        );
        assert!(!authorization(&seen[1]));
        assert!(!seen[1]
            .iter()
            .any(|line| line.starts_with("Nostr-Federated-Identity:")));
    }
    #[test]
    fn rejects_malformed_authorization_before_running_git() {
        for token in ["", "a\r\nX-Injected: 1", &"a".repeat(8193)] {
            let error = prepare_git("https://example.invalid/git/owner/repo", "", Some(token))
                .err()
                .unwrap();
            assert_eq!(error, "Invalid repository authorization");
        }
    }
    #[cfg(unix)]
    #[test]
    fn access_rule_socket_reaches_git() {
        use std::os::unix::{fs::PermissionsExt, net::UnixListener};

        let home = tempfile::tempdir_in("/tmp").unwrap();
        let socket = home.path().join("team.sock");
        let _agent = UnixListener::bind(&socket).unwrap();
        fs::write(
            home.path().join(crate::access::FILE_NAME),
            r#"{"version": 1, "rules": [{"host": "git.example.com", "pathPrefix": "/team/", "sshUser": "git", "sshAgentSocket": "~/team.sock"}]}"#,
        )
        .unwrap();
        let transport = crate::access::load(home.path(), None)
            .resolve(
                "ssh://git@git.example.com/team/plugin.git",
                false,
                home.path(),
            )
            .unwrap();
        let mut git = Git::new().unwrap();
        git.ssh_auth_sock = transport.ssh_auth_sock;

        let bin = home.path().join("bin");
        fs::create_dir(&bin).unwrap();
        let executable = bin.join("git");
        fs::write(&executable, "#!/bin/sh\n/usr/bin/printenv SSH_AUTH_SOCK\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let mut command = git.command();
        command.env("PATH", &bin);
        let output = git.run_command(command, 1024).unwrap();
        assert_eq!(
            String::from_utf8(output).unwrap().trim(),
            socket.to_str().unwrap()
        );
    }
    #[cfg(unix)]
    #[test]
    fn failed_reads_name_the_access_rule() {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let socket = home.path().join("team.sock");
        let _agent = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        fs::write(
            home.path().join(crate::access::FILE_NAME),
            format!(
                r#"{{"version": 1, "rules": [{{"host": "git.invalid", "pathPrefix": "/team/", "sshUser": "git", "sshAgentSocket": "{}"}}]}}"#,
                socket.display()
            ),
        )
        .unwrap();
        let access = crate::access::load(home.path(), None);
        let error = match prepare_git_authorized(
            "https://git.invalid/team/plugin.git",
            "",
            None,
            None,
            None,
            None,
            &access,
        ) {
            Ok(_) => panic!("git.invalid cannot be read"),
            Err(error) => error,
        };
        // Only the suffix: the failure text itself depends on how far Git got before it
        // removed its partial clone.
        assert!(
            error.ends_with(&format!(
                " (repository access rule git.invalid/team/, agent socket {})",
                socket.display()
            )),
            "{error}"
        );
        let direct = match prepare_git_authorized(
            "https://git.invalid/other/plugin.git",
            "",
            None,
            None,
            None,
            None,
            &access,
        ) {
            Ok(_) => panic!("git.invalid cannot be read"),
            Err(error) => error,
        };
        assert!(!direct.contains("repository access rule"), "{direct}");
    }
    #[test]
    fn git_deadline_and_output_limits_fail() {
        let mut git = Git::new().unwrap();
        assert!(git.run(&["--version"], 1).is_err());
        git.deadline = Instant::now();
        assert!(git
            .run(&["--version"], LIMIT)
            .unwrap_err()
            .contains("60 seconds"));
    }
    #[cfg(unix)]
    #[test]
    fn timeout_terminates_spawned_descendant_before_it_can_write() {
        let mut git = Git::new().unwrap();
        git.deadline = Instant::now() + Duration::from_millis(500);
        let mut command = Command::new("sh");
        command
            .current_dir(git.scratch.path())
            .args(["-c", "(touch child-started; sleep 1; touch escaped) & wait"]);
        let result = git.run_command(command, LIMIT);
        assert!(result.unwrap_err().contains("60 seconds"));
        assert!(git.scratch.path().join("child-started").exists());
        thread::sleep(Duration::from_millis(1200));
        assert!(!git.scratch.path().join("escaped").exists());
        // Positive control: the same delayed descendant really can write without a timeout.
        git.deadline = Instant::now() + Duration::from_secs(5);
        let mut control = Command::new("sh");
        control
            .current_dir(git.scratch.path())
            .args(["-c", "(sleep 1; touch escaped) & wait"]);
        git.run_command(control, LIMIT).unwrap();
        assert!(git.scratch.path().join("escaped").exists());
    }
}
