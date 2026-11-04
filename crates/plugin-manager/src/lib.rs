//! Installation and settings never execute plugin code. Both desktop and CLI use this crate.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use nostr::{
    event::{Event, EventBuilder, FinalizeEvent, Kind, Tag},
    key::{Keys, SecretKey},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub mod access;
pub mod imports;
pub mod managed;
mod migrate_agent_flag;

pub type Result<T> = std::result::Result<T, String>;
const LIMIT: u64 = 8 * 1024 * 1024;
const MAX_README_BYTES: usize = 256 * 1024;
const MAX_ICON_BYTES: usize = 1024 * 1024;
const MAX_ICON_DIMENSION: u32 = 4096;
const MAX_ICON_PIXELS: u64 = 1024 * 1024;
pub const DEFAULT_HOST_COMMAND_OUTPUT_BYTES: u64 = 4096;
pub const MAX_HOST_COMMAND_OUTPUT_BYTES: u64 = 1024 * 1024;
pub const MAX_HOST_COMMAND_INPUT_BYTES: u64 = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub api_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discovery: Option<Discovery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<HostGrants>,
}
/// Display-only metadata is deliberately forward-compatible. Unknown fields are
/// ignored so adding a discovery hint does not make a plugin unloadable.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostGrants {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub federated_identity: Option<FederatedIdentityGrant>,
    /// Hook callbacks may observe and influence these agent types.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agent_hooks: Vec<String>,
    #[serde(default)]
    pub commands: Vec<HostCommand>,
    #[serde(default)]
    pub network_origins: Vec<String>,
    /// Programs the plugin may start as long-lived processes. Unlike a command,
    /// a process takes stdin and the caller appends its own arguments.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub processes: Vec<HostProcess>,
    /// The plugin may serve MCP servers on loopback HTTP to the agents it
    /// runs, answering their messages itself.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub mcp: bool,
    /// The plugin may read files and resolve directories with the user's own
    /// access, without starting a program for it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub files: bool,
    /// Pathless temporary saves in host-selected private storage; no read access.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub managed_files: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FederatedIdentityGrant {
    pub authority: String,
    pub operations: Vec<AuthenticatedOperation>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuthenticatedOperation {
    pub method: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HostCommand {
    pub id: String,
    pub program: String,
    pub args: Vec<String>,
    #[serde(
        default,
        rename = "maxInputBytes",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_input_bytes: Option<u64>,
    #[serde(
        default,
        rename = "maxOutputBytes",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_output_bytes: Option<u64>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HostProcess {
    pub id: String,
    pub program: String,
    /// Fixed leading arguments; the caller's arguments follow them.
    #[serde(default)]
    pub args: Vec<String>,
    /// Run the copy the app ships in its `bin` resources, never one on PATH.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bundled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<ProcessArtifact>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessArtifact {
    pub path: String,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub siblings: Vec<ProcessArtifactSibling>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessArtifactSibling {
    pub name: String,
    pub sha256: String,
}
fn valid_sha256(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
/// An artifact is absolute, or under the user's home written `~/…`, which the
/// host expands when it starts the process.
fn valid_artifact(artifact: &ProcessArtifact) -> bool {
    let path = Path::new(&artifact.path);
    if !(path.is_absolute() || artifact.path.starts_with("~/"))
        || artifact.path.len() > 4096
        || artifact.path.contains('\0')
        || !valid_sha256(&artifact.sha256)
        || artifact.siblings.len() > 16
    {
        return false;
    }
    let mut names = std::collections::HashSet::new();
    artifact.siblings.iter().all(|sibling| {
        let name = &sibling.name;
        !name.is_empty()
            && name.len() <= 80
            && name != "."
            && name != ".."
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
            && valid_sha256(&sibling.sha256)
            && names.insert(name)
    })
}
fn valid_program(program: &str, args: &[String]) -> bool {
    !program.is_empty()
        && program.len() <= 80
        && program
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        && args.len() <= 16
        && args
            .iter()
            .all(|argument| argument.len() <= 1024 && !argument.contains('\0'))
}
impl Manifest {
    pub fn validate(&self) -> Result<()> {
        valid_id(&self.id)?;
        if self.name.trim().is_empty() || self.name.len() > 80 {
            return Err("Name must contain 1–80 bytes of text".into());
        }
        if self
            .description
            .as_ref()
            .is_some_and(|description| description.trim().is_empty() || description.len() > 280)
        {
            return Err("Description must contain 1–280 bytes of text".into());
        }
        if self.api_version != 1 {
            return Err("Only page plugin API version 1 is supported".into());
        }
        if let Some(discovery) = &self.discovery {
            if let Some(category) = &discovery.category {
                valid_id(category)?;
            }
            if discovery.tags.len() > 16 {
                return Err("Too many discovery tags".into());
            }
            let mut tags = std::collections::HashSet::new();
            for tag in &discovery.tags {
                if tag.trim().is_empty() || tag.len() > 80 || tag.chars().any(char::is_control) {
                    return Err(
                        "Discovery tags must contain 1–80 bytes of text without control characters"
                            .into(),
                    );
                }
                let key = tag
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .to_lowercase();
                if !tags.insert(key) {
                    return Err("Duplicate discovery tag".into());
                }
            }
        }
        if let Some(host) = &self.host {
            if host.agent_hooks.len() > 16
                || host.commands.len() > 16
                || host.network_origins.len() > 16
                || host.processes.len() > 16
            {
                return Err("Too many host declarations".into());
            }
            let mut hook_types = std::collections::HashSet::new();
            for key in &host.agent_hooks {
                let (plugin, kind) = key.split_once('/').ok_or("Invalid agent hook type")?;
                valid_id(plugin)?;
                valid_id(kind)?;
                if !hook_types.insert(key) {
                    return Err("Duplicate agent hook type".into());
                }
            }
            if let Some(grant) = &host.federated_identity {
                if grant.authority.is_empty()
                    || grant.authority.len() > 64
                    || !grant
                        .authority
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                {
                    return Err("Invalid authenticated authority".into());
                }
                if grant.operations.is_empty()
                    || grant.operations.len() > 64
                    || grant.operations.iter().any(|op| {
                        !matches!(
                            op.method.as_str(),
                            "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE"
                        ) || op.path.len() > 2048
                            || !op.path.starts_with('/')
                            || op.path.contains(['%', '\\', '?', '#'])
                            || op.path.contains("//")
                            || op.path.chars().any(char::is_whitespace)
                            || op.path.split('/').any(|part| matches!(part, "." | ".."))
                    })
                {
                    return Err("Invalid authenticated authority operations".into());
                }
            }
            let mut command_ids = std::collections::HashSet::new();
            for command in &host.commands {
                valid_id(&command.id)?;
                if !command_ids.insert(&command.id)
                    || !valid_program(&command.program, &command.args)
                    || command
                        .max_input_bytes
                        .is_some_and(|limit| !(1..=MAX_HOST_COMMAND_INPUT_BYTES).contains(&limit))
                    || command
                        .max_output_bytes
                        .is_some_and(|limit| !(1..=MAX_HOST_COMMAND_OUTPUT_BYTES).contains(&limit))
                {
                    return Err("Invalid host command declaration".into());
                }
            }
            let mut process_ids = std::collections::HashSet::new();
            for process in &host.processes {
                valid_id(&process.id)?;
                if !process_ids.insert(&process.id)
                    || !valid_program(&process.program, &process.args)
                    || (process.bundled && process.artifact.is_some())
                    || process
                        .artifact
                        .as_ref()
                        .is_some_and(|artifact| !valid_artifact(artifact))
                {
                    return Err("Invalid host process declaration".into());
                }
            }
            let mut origins = std::collections::HashSet::new();
            for origin in &host.network_origins {
                let url = url::Url::parse(origin).map_err(err)?;
                if url.scheme() != "https"
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.origin().ascii_serialization() != *origin
                    || !origins.insert(origin)
                {
                    return Err("Invalid HTTPS origin declaration".into());
                }
            }
        }
        Ok(())
    }
}
pub fn valid_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 80
        || !id.as_bytes()[0].is_ascii_lowercase()
        || !id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'-')
        || id.split(['.', '-']).any(str::is_empty)
    {
        return Err("Invalid identifier (use lowercase letters, digits, dots or hyphens)".into());
    }
    Ok(())
}
/// The `BUZZ_BUILDERLAB_URL` build input's origin, or empty when unconfigured.
pub const BUILDERLAB_ORIGIN: &str = env!("BUZZ_BUILDERLAB_ORIGIN");
/// Exact Apps domain paired with the build's login origin, or empty when native SSO is unconfigured.
pub const BUILDERLAB_APPS_DOMAIN: &str = env!("BUZZ_BUILDERLAB_APPS_DOMAIN");
/// The Apps Platform control plane of the tenant whose Builderlab sign-in
/// `origin` is, which the bundled Builderlab plugin deploys apps to. Kept in
/// step with `src/bundled/builderlab/apps/environment.ts`.
pub fn apps_control_plane(origin: &str) -> Option<&'static str> {
    match origin {
        "https://app.builderlab.xyz" => Some("https://compose-ctrl.builderlab.xyz"),
        "https://app.builderlabstaging.xyz" => Some("https://compose-ctrl.builderlabstaging.xyz"),
        "https://block.builderlab.xyz" => Some("https://compose-ctrl.block.builderlab.xyz"),
        _ => None,
    }
}
/// The Builderlab routes an FI build forwards with the native session.
const BUILDERLAB_FI_ROUTES: &[&str] = &[
    "v3/beekeeper/register-agent",
    "v3/beekeeper/delete-agent",
    "v3/beekeeper/update-agent",
    "v3/beekeeper/update-agent-profile",
    "v3/beekeeper/attest-agent",
    "v3/beekeeper/list-agents",
    "v3/beekeeper/get-model-catalog",
    "v3/beekeeper/cancel-agent-turn",
    "GET v1/auth/me",
    "v1/buzz/nostr-identities/current",
    "v1/buzz/nostr-identities/delete",
    "v1/buzz/nostr-identities/challenge",
    "v1/buzz/nostr-identities/verify",
    "v1/buzz/nsec-backups/status",
    "v1/buzz/communities/list",
    "v1/buzz/communities/availability",
    "v1/buzz/communities",
    "v1/buzz/communities/archive",
    "v1/buzz/communities/unarchive",
    "v1/buzz/communities/delete",
    "v1/buzz/communities/transfer",
    "v1/buzz/known-communities/list",
    "v1/buzz/known-communities/add",
    "v1/buzz/known-communities/remove",
];
/// The matching Builderlab API base path, or empty when unconfigured.
pub const BUILDERLAB_API_BASE_PATH: &str = env!("BUZZ_BUILDERLAB_API_BASE_PATH");
pub fn bundled_manifests() -> Vec<Manifest> {
    let mut builderlab: Manifest = serde_json::from_str(include_str!(
        "../../../src/bundled/builderlab/manifest.json"
    ))
    .expect("builderlab manifest");
    let origin = BUILDERLAB_ORIGIN;
    let descriptor = env!("BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG");
    builderlab.host = Some(if descriptor.is_empty() {
        HostGrants {
            files: apps_control_plane(origin).is_some(),
            network_origins: if origin.is_empty() {
                vec![]
            } else {
                std::iter::once(origin)
                    .chain(apps_control_plane(origin))
                    .map(Into::into)
                    .collect()
            },
            ..HostGrants::default()
        }
    } else {
        // An FI build reaches Builderlab only through the native session
        // forwarder: no renderer network or file access.
        let config: serde_json::Value =
            serde_json::from_str(descriptor).expect("validated FI descriptor");
        let base = config["apiBasePath"].as_str().expect("API base");
        HostGrants {
            federated_identity: Some(FederatedIdentityGrant {
                authority: config["id"].as_str().expect("authority").into(),
                operations: BUILDERLAB_FI_ROUTES
                    .iter()
                    .map(|route| {
                        // Routes are POST unless they name another method.
                        let (method, route) = route.split_once(' ').unwrap_or(("POST", route));
                        AuthenticatedOperation {
                            method: method.into(),
                            path: format!("{base}{route}"),
                        }
                    })
                    .collect(),
            }),
            ..HostGrants::default()
        }
    });
    vec![
        serde_json::from_str(include_str!("../../../src/bundled/huddles/manifest.json"))
            .expect("huddles manifest"),
        builderlab,
        serde_json::from_str(include_str!("../../../src/bundled/pairing/manifest.json"))
            .expect("valid pairing manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/todos/manifest.json"))
            .expect("todos manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/diffs/manifest.json"))
            .expect("bundled diffs manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/mermaid/manifest.json"))
            .expect("bundled mermaid manifest"),
        serde_json::from_str(include_str!(
            "../../../src/bundled/identity-naming/manifest.json"
        ))
        .expect("identity naming manifest"),
        serde_json::from_str(include_str!(
            "../../../src/bundled/agent-activity/manifest.json"
        ))
        .expect("agent activity manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/terminal/manifest.json"))
            .expect("terminal manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/profiles/manifest.json"))
            .expect("valid bundled Profiles manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/links/manifest.json"))
            .expect("links manifest"),
        serde_json::from_str(include_str!(
            "../../../src/bundled/voice-notes/manifest.json"
        ))
        .expect("voice notes manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/channels/manifest.json"))
            .expect("channels manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/github/manifest.json"))
            .expect("github manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/inbox/manifest.json"))
            .expect("valid Inbox manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/reminders/manifest.json"))
            .expect("reminders manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/bestie/manifest.json"))
            .expect("bestie manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/usage/manifest.json"))
            .expect("usage manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/repos/manifest.json"))
            .expect("projects manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/agents/manifest.json"))
            .expect("agents manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/watching/manifest.json"))
            .expect("watching manifest"),
        serde_json::from_str(include_str!(
            "../../../src/bundled/claude-code/manifest.json"
        ))
        .expect("claude manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/codex/manifest.json"))
            .expect("codex manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/goose/manifest.json"))
            .expect("goose manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/pi/manifest.json"))
            .expect("pi manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/workflows/manifest.json"))
            .expect("workflows manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/feedback/manifest.json"))
            .expect("feedback manifest"),
        serde_json::from_str(include_str!(
            "../../../src/bundled/moderation/manifest.json"
        ))
        .expect("moderation manifest"),
        serde_json::from_str(include_str!(
            "../../../src/bundled/relay-staff/manifest.json"
        ))
        .expect("relay staff manifest"),
        serde_json::from_str(include_str!(
            "../../../src/bundled/relay-notes/manifest.json"
        ))
        .expect("relay notes manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/typesafe/manifest.json"))
            .expect("typesafe manifest"),
    ]
}
/// New bundles must opt in to the default-on policy.
fn enabled_by_default(id: &str) -> bool {
    matches!(
        id,
        "buzz.channels"
            | "buzz.feedback"
            | "buzz.diffs"
            | "buzz.mermaid"
            | "buzz.identity-naming"
            | "buzz.agent-activity"
            | "buzz.terminal"
            | "buzz.profiles"
            | "buzz.links"
            | "buzz.voice-notes"
            | "buzz.huddles"
            | "buzz.github"
            | "buzz.watching"
            | "buzz.pairing"
            | "buzz.inbox"
            | "buzz.repos"
            | "buzz.agents"
            | "buzz.claude-code"
            | "buzz.codex"
            | "buzz.goose"
            | "block.builderlab"
            | "buzz.moderation"
            | "buzz.relay-staff"
            | "buzz.typesafe"
    )
}
/// Bundled ids that older profiles may still hold as installed plugins.
const FORMERLY_INSTALLED: &[&str] = &["buzz.claude-code", "buzz.codex"];
/// Host-owned features stay reserved even though they have no catalog entries.
const BUILT_IN: &[&str] = &["buzz.emoji", "buzz.mentions"];
fn is_bundled(id: &str) -> bool {
    bundled_manifests().iter().any(|manifest| manifest.id == id)
}
fn is_reserved(id: &str) -> bool {
    BUILT_IN.contains(&id) || is_bundled(id)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Installed {
    manifest: Manifest,
    current: String,
    #[serde(default)]
    current_signature: Option<Event>,
    #[serde(default)]
    current_source: Option<InstallSource>,
    previous: Option<String>,
    #[serde(default)]
    previous_signature: Option<Event>,
    #[serde(default)]
    previous_source: Option<InstallSource>,
    enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    readme_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon_png_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon_jpg_revision: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReloadSource {
    root: PathBuf,
    path: String,
}
impl ReloadSource {
    pub fn folder(root: PathBuf, path: String) -> Result<Self> {
        if !root.is_absolute() {
            return Err("Reload source root must be absolute".into());
        }
        validate_candidate_path(&path)?;
        Ok(Self { root, path })
    }
}
// Untagged keeps existing {root, path} folder metadata readable without migration.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum InstallSource {
    Folder(ReloadSource),
    Git(GitSource),
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitSource {
    pub repository: String,
    pub reference: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registry {
    version: u32,
    bundled_enabled: bool,
    #[serde(default)]
    bundled_overrides: BTreeMap<String, bool>,
    installed: BTreeMap<String, Installed>,
}
impl Default for Registry {
    fn default() -> Self {
        Self {
            version: 2,
            bundled_enabled: true,
            bundled_overrides: BTreeMap::new(),
            installed: BTreeMap::new(),
        }
    }
}
// Freeze known defaults so later releases cannot silently withdraw a feature.
fn pin_bundled_defaults(registry: &mut Registry, existing_profile: bool) -> bool {
    let mut changed = false;
    for manifest in bundled_manifests() {
        registry
            .bundled_overrides
            .entry(manifest.id.clone())
            .or_insert_with(|| {
                changed = true;
                enabled_by_default(&manifest.id)
                    || (existing_profile
                        && matches!(manifest.id.as_str(), "buzz.reminders" | "buzz.workflows"))
            });
    }
    changed
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Artifact {
    manifest: Manifest,
    code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    readme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon_png: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon_jpg: Option<String>,
}
impl Artifact {
    fn readme_revision(&self) -> Option<String> {
        self.readme.as_deref().map(|value| hash(value.as_bytes()))
    }
}
// Revisions are opaque content identities. Hash the canonical base64 directly so
// catalog/preview comparisons do not decode an already validated image again.
fn icon_revision(encoded: Option<&str>) -> Option<String> {
    encoded.map(|value| hash(value.as_bytes()))
}
fn decode_icon(encoded: Option<&str>) -> Result<Option<Vec<u8>>> {
    encoded
        .map(|value| BASE64.decode(value).map_err(err))
        .transpose()
}
#[derive(Clone)]
struct Release {
    bytes: Vec<u8>,
    signature: Option<Event>,
}
const RELEASE_MARKER: &str = "buzz-plugin-release-v1";
const RELEASE_KIND: Kind = Kind::Custom(1064);
const SIGNED_ROLLBACK_ERROR: &str = "Cannot roll back a signed plugin to an unsigned revision";

fn publisher(bytes: &[u8], signature: &Event) -> Result<String> {
    publisher_for_hash(&hash(bytes), signature)
}
fn publisher_for_hash(digest: &str, signature: &Event) -> Result<String> {
    signature
        .verify()
        .map_err(|_| "Invalid plugin release event ID or signature")?;
    if signature.kind != RELEASE_KIND || !signature.content.is_empty() {
        return Err("Plugin release must be a NIP-PS event with empty content".into());
    }
    for (key, expected) in [("x", digest.to_string()), ("t", RELEASE_MARKER.into())] {
        let values: Vec<&str> = signature
            .tags
            .iter()
            .filter_map(|tag| {
                let parts = tag.as_slice();
                (parts.first().map(String::as_str) == Some(key))
                    .then(|| (parts.len() == 2).then(|| parts[1].as_str()))
            })
            .collect::<Option<Vec<_>>>()
            .ok_or("Incomplete plugin release tag")?;
        if values.len() != 1 || values[0] != expected {
            return Err(format!("Invalid or ambiguous plugin release {key} tag"));
        }
    }
    Ok(signature.pubkey.to_hex())
}

pub fn sign_release(directory: &Path, key_text: &str) -> Result<String> {
    let bytes = imports::prepare_unsigned_artifact(directory)?;
    let secret = SecretKey::parse(key_text.trim()).map_err(|_| "Invalid signing key")?;
    let tags = [
        Tag::custom("x", [hash(&bytes).as_str()]),
        Tag::custom("t", [RELEASE_MARKER]),
    ];
    let event = EventBuilder::new(RELEASE_KIND, "")
        .tags(tags)
        .finalize(&Keys::new(secret))
        .map_err(err)?;
    let publisher = publisher(&bytes, &event)?;
    atomic_write(&directory.join("plugin.artifact.json"), &bytes)?;
    atomic_write(
        &directory.join("plugin.signature.json"),
        &serde_json::to_vec_pretty(&event).map_err(err)?,
    )?;
    Ok(publisher)
}

/// Sign with the desktop human identity without creating or exporting a credential.
pub fn sign_release_saved(directory: &Path) -> Result<String> {
    sign_release_from_store(directory, buzz_credential_store::find_human)
}

fn sign_release_from_store<K: AsRef<[u8]>>(
    directory: &Path,
    read: impl FnOnce() -> std::result::Result<K, buzz_credential_store::Error>,
) -> Result<String> {
    use bech32::{primitives::decode::CheckedHrpstring, Bech32};
    use buzz_credential_store::Error;
    let bytes = read().map_err(|error| match error {
        Error::Absent => "Set up your Buzz human identity in the desktop app before signing",
        Error::Denied => "Secure storage access was denied; unlock it and retry signing",
        Error::Busy => "Secure storage is busy; retry signing shortly",
        Error::Corrupt => "Saved Buzz human identity is malformed; nothing was changed",
        _ => "Saved Buzz human identity could not be read from secure storage",
    })?;
    let text = std::str::from_utf8(bytes.as_ref())
        .map_err(|_| "Saved Buzz human identity is malformed; nothing was changed")?
        .trim();
    if text.len() != 63
        || !(text.starts_with("nsec1") || text.starts_with("NSEC1"))
        || CheckedHrpstring::new::<Bech32>(text).is_err()
        || SecretKey::parse(text).is_err()
    {
        return Err("Saved Buzz human identity is malformed; nothing was changed".into());
    }
    sign_release(directory, text)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub manifest: Manifest,
    pub source: &'static str,
    pub enabled: bool,
    pub revision: String,
    pub previous: Option<String>,
    pub has_signature: bool,
    pub rollback_blocked_reason: Option<&'static str>,
    pub reloadable: bool,
    pub update_source: Option<InstallSource>,
    pub error: Option<String>,
    pub publisher: Option<String>,
    pub readme_revision: Option<String>,
    pub icon_png_revision: Option<String>,
    pub icon_jpg_revision: Option<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginContent {
    pub readme: Option<String>,
    pub icon_png: Option<String>,
    pub icon_jpg: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub profile: String,
    pub location: String,
    pub plugins: Vec<PluginInfo>,
}
#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum InstallationResult {
    Ready {
        catalog: Catalog,
        #[serde(rename = "externalPluginsPaused")]
        external_plugins_paused: bool,
        #[serde(skip_serializing_if = "managed::Managed::is_absent")]
        managed: managed::Managed,
    },
    Recovery {
        reason: String,
        #[serde(rename = "canReset")]
        can_reset: bool,
    },
}
/// The desktop app data folder a CLI targets by default: a debug CLI the
/// development app's, a release CLI the installed app's. Each refuses while the
/// app has yet to fill that folder from the installed app's older one: creating
/// it would stop the development copy, or leave both and stop the release move.
fn default_home() -> Result<PathBuf> {
    let data =
        dirs::data_dir().ok_or("Cannot determine application data directory; set BUZZODZ_HOME")?;
    let (home, older, open): (_, &[_], _) = if cfg!(debug_assertions) {
        (
            "xyz.block.buzz.desktop.dev",
            &["xyz.block.buzz.desktop", "dev.local.buzz.foundation"],
            "Development Buzz has not copied the installed app's storage yet. Run `just desktop` once",
        )
    } else {
        (
            "xyz.block.buzz.desktop",
            &["dev.local.buzz.foundation"],
            "Buzz has not moved its storage to its 1.0 folder yet. Open Buzz once",
        )
    };
    let home = data.join(home);
    if !home.exists() && older.iter().any(|old| data.join(old).exists()) {
        return Err(format!("{open}, then try again, or pass --home."));
    }
    Ok(home)
}
#[derive(Clone)]
pub struct Manager {
    home: PathBuf,
    root: PathBuf,
    profile: String,
    safe_mode: bool,
    existing_profile: bool,
}
impl Manager {
    /// Host control-plane location that protected workers must not modify.
    pub fn storage_root(&self) -> &std::path::Path {
        &self.root
    }

    pub fn open(home: Option<PathBuf>, profile: &str, safe_mode: bool) -> Result<Self> {
        valid_id(profile)?;
        let home = match home.or_else(|| std::env::var_os("BUZZODZ_HOME").map(PathBuf::from)) {
            Some(home) => home,
            None => default_home()?,
        };
        if !home.is_absolute() {
            return Err("Plugin home must be an absolute path".into());
        }
        let root = home.join("profiles").join(profile);
        // Catalog reads created this folder even when no preferences were saved.
        let existing_profile = root.try_exists().map_err(err)?;
        Ok(Self {
            root,
            home,
            profile: profile.into(),
            safe_mode,
            existing_profile,
        })
    }
    /// Opens the environment's plugin home, else `home`: the desktop passes its own app data folder.
    pub fn from_env(home: Option<PathBuf>) -> Result<Self> {
        Self::open(
            std::env::var_os("BUZZODZ_HOME").map(PathBuf::from).or(home),
            &std::env::var("BUZZODZ_PROFILE").unwrap_or_else(|_| "default".into()),
            std::env::var("BUZZODZ_SAFE_MODE").as_deref() == Ok("1"),
        )
    }
    /// The managed plugin policy and how each recommendation stands in `catalog`.
    pub fn managed(&self, catalog: &Catalog) -> managed::Managed {
        managed::status(
            managed::path(&self.home, std::env::var_os(managed::PATH_ENV)),
            catalog,
        )
    }
    /// Repository access rules for Git imports, from the file beside the profile folders.
    pub fn repository_access(&self) -> access::AccessRules {
        access::load(&self.home, std::env::var_os(access::PATH_ENV))
    }
    fn lock(&self) -> Result<File> {
        fs::create_dir_all(&self.root).map_err(err)?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.root.join("registry.lock"))
            .map_err(err)?;
        file.lock().map_err(err)?;
        Ok(file)
    }
    fn read(&self) -> Result<Registry> {
        let path = self.root.join("registry.json");
        let mut r: Registry = match File::open(&path) {
            Ok(file) => serde_json::from_str(&read_file_limited(file)?).map_err(err)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Registry::default(),
            Err(error) => return Err(err(error)),
        };
        if r.version != 1 && r.version != 2 {
            return Err(
                "Unsupported settings version; use a compatible Buzz or recover settings".into(),
            );
        }
        // These shipped as installable plugins before being bundled. The bundled copy
        // replaces the installed one; a disabled install keeps the bundled copy off.
        for id in FORMERLY_INSTALLED {
            if let Some(old) = r.installed.remove(*id) {
                if !old.enabled {
                    r.bundled_overrides.entry((*id).into()).or_insert(false);
                }
            }
        }
        for (id, p) in &r.installed {
            p.manifest.validate()?;
            if *id != p.manifest.id || is_reserved(id) {
                return Err("Invalid installed plugin identity".into());
            }
            valid_hash(&p.current)?;
            if let Some(h) = &p.previous {
                valid_hash(h)?;
            }
        }
        let renamed = migrate_agent_flag::migrate(&mut r);
        let pinned = pin_bundled_defaults(&mut r, self.existing_profile);
        if renamed {
            self.save(&r)?;
        } else if pinned {
            // Readable settings must remain usable when the default snapshot
            // cannot be written. Later reads retry; explicit edits still fail.
            let _ = self.save(&r);
        }
        Ok(r)
    }
    fn save(&self, r: &Registry) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(r).map_err(err)?;
        if bytes.len() as u64 > LIMIT {
            return Err(
                "Plugin registry exceeds 8 MiB; reduce release metadata or remove plugins".into(),
            );
        }
        atomic_write(&self.root.join("registry.json"), &bytes)
    }
    fn artifact_path(&self, id: &str, revision: &str) -> PathBuf {
        self.root
            .join("artifacts")
            .join(id)
            .join(format!("{revision}.json"))
    }
    fn artifact(&self, id: &str, revision: &str, signature: Option<&Event>) -> Result<Artifact> {
        valid_id(id)?;
        valid_hash(revision)?;
        let text = read_limited(&self.artifact_path(id, revision))?;
        if hash(text.as_bytes()) != revision {
            return Err(
                "Installed artifact failed its integrity check; reinstall or roll back".into(),
            );
        }
        if let Some(signature) = signature {
            publisher(text.as_bytes(), signature)?;
        }
        let a: Artifact = serde_json::from_str(&text).map_err(err)?;
        a.manifest.validate()?;
        if a.manifest.id != id {
            return Err("Artifact identity mismatch".into());
        }
        Ok(a)
    }
    pub fn external_plugins_paused(&self) -> bool {
        self.safe_mode
    }
    pub fn catalog(&self) -> Result<Catalog> {
        let registry = self.lock().and_then(|_lock| self.read())?;
        let mut plugins: Vec<PluginInfo> = bundled_manifests()
            .into_iter()
            .map(|manifest| {
                // Required even when an older profile saved a disabled override.
                let enabled = manifest.id == "buzz.channels"
                    || registry
                        .bundled_overrides
                        .get(&manifest.id)
                        .copied()
                        .unwrap_or_else(|| enabled_by_default(&manifest.id));
                PluginInfo {
                    manifest,
                    source: "bundled",
                    enabled,
                    revision: "bundled".into(),
                    previous: None,
                    has_signature: false,
                    rollback_blocked_reason: None,
                    reloadable: false,
                    update_source: None,
                    error: None,
                    publisher: None,
                    readme_revision: None,
                    icon_png_revision: None,
                    icon_jpg_revision: None,
                }
            })
            .collect();
        for (id, p) in registry.installed {
            // Catalog polling stays cheap; verify content hashes before enabling/loading.
            let has_signature = p.current_signature.is_some();
            let rollback_blocked_reason =
                (has_signature && p.previous.is_some() && p.previous_signature.is_none())
                    .then_some(SIGNED_ROLLBACK_ERROR);
            let mut error = fs::metadata(self.artifact_path(&id, &p.current))
                .map_err(err)
                .err();
            let publisher = if error.is_none() {
                p.current_signature.as_ref().and_then(|signature| {
                    match publisher_for_hash(&p.current, signature) {
                        Ok(key) => Some(key),
                        Err(reason) => {
                            error = Some(reason);
                            None
                        }
                    }
                })
            } else {
                None
            };
            plugins.push(PluginInfo {
                manifest: p.manifest,
                source: "external",
                enabled: p.enabled,
                revision: p.current,
                previous: p.previous,
                has_signature,
                rollback_blocked_reason,
                reloadable: matches!(&p.current_source, Some(InstallSource::Folder(_))),
                update_source: p.current_source,
                error,
                publisher,
                readme_revision: p.readme_revision,
                icon_png_revision: p.icon_png_revision,
                icon_jpg_revision: p.icon_jpg_revision,
            });
        }
        Ok(Catalog {
            profile: self.profile.clone(),
            location: self.root.display().to_string(),
            plugins,
        })
    }
    pub fn install(&self, directory: &Path) -> Result<Catalog> {
        let source = ReloadSource::folder(directory.canonicalize().map_err(err)?, ".".into())?;
        self.install_artifact(
            &prepare_artifact(directory)?,
            Some(InstallSource::Folder(source)),
        )
    }
    fn install_artifact(
        &self,
        release: &Release,
        source: Option<InstallSource>,
    ) -> Result<Catalog> {
        let bytes = &release.bytes;
        let artifact = release.artifact()?;
        let manifest = artifact.manifest.clone();
        let readme_revision = artifact.readme_revision();
        let icon_png_revision = icon_revision(artifact.icon_png.as_deref());
        let icon_jpg_revision = icon_revision(artifact.icon_jpg.as_deref());
        let revision = hash(bytes);
        {
            let _lock = self.lock()?;
            let mut registry = self.read()?;
            let old = registry.installed.get(&manifest.id);
            if let Some(old) = old {
                if let Some(previous) = &old.current_signature {
                    let previous_publisher = publisher_for_hash(&old.current, previous)?;
                    if release.publisher().as_deref() != Some(previous_publisher.as_str()) {
                        return Err("Publisher changed or signed plugin became unsigned; remove and reinstall to change publisher".into());
                    }
                }
            }
            let (previous, previous_source) = old.map_or((None, None), |p| {
                if p.current == revision {
                    (p.previous.clone(), p.previous_source.clone())
                } else {
                    (Some(p.current.clone()), p.current_source.clone())
                }
            });
            let enabled = old.is_some_and(|p| p.enabled);
            let previous_signature = old.and_then(|p| {
                if p.current == revision {
                    p.previous_signature.clone()
                } else {
                    p.current_signature.clone()
                }
            });
            atomic_write(&self.artifact_path(&manifest.id, &revision), bytes)?;
            registry.installed.insert(
                manifest.id.clone(),
                Installed {
                    manifest,
                    current: revision,
                    current_signature: release.signature.clone(),
                    current_source: source,
                    previous,
                    previous_signature,
                    previous_source,
                    enabled,
                    readme_revision,
                    icon_png_revision,
                    icon_jpg_revision,
                },
            );
            self.save(&registry)?;
        }
        self.catalog()
    }
    pub fn change(&self, action: &str, id: &str) -> Result<Catalog> {
        valid_id(id)?;
        if BUILT_IN.contains(&id) {
            return Err("Built-in conversation features cannot be managed as plugins".into());
        }
        {
            let _lock = self.lock()?;
            let mut registry = self.read()?;
            if is_bundled(id) {
                match action {
                    "enable" => {
                        registry.bundled_overrides.insert(id.into(), true);
                    }
                    "disable" => {
                        if id == "buzz.channels" {
                            return Err("Channels is required and cannot be disabled".into());
                        }
                        registry.bundled_overrides.insert(id.into(), false);
                    }
                    _ => return Err("Bundled pages can only be enabled or disabled".into()),
                }
            } else {
                let p = registry
                    .installed
                    .get_mut(id)
                    .ok_or("Plugin is not installed")?;
                match action {
                    "enable" => {
                        self.artifact(id, &p.current, p.current_signature.as_ref())?;
                        p.enabled = true;
                    }
                    "disable" => p.enabled = false,
                    "remove" => {
                        registry.installed.remove(id);
                    }
                    "rollback" => {
                        let previous = p.previous.clone().ok_or("No previous revision")?;
                        if p.current_signature.is_some() && p.previous_signature.is_none() {
                            return Err(SIGNED_ROLLBACK_ERROR.into());
                        }
                        let a = self.artifact(id, &previous, p.previous_signature.as_ref())?;
                        p.current = previous;
                        p.current_signature = p.previous_signature.take();
                        p.current_source = p.previous_source.take();
                        p.previous = None;
                        p.readme_revision = a.readme_revision();
                        p.icon_png_revision = icon_revision(a.icon_png.as_deref());
                        p.icon_jpg_revision = icon_revision(a.icon_jpg.as_deref());
                        p.manifest = a.manifest;
                    }
                    _ => return Err("Unknown management action".into()),
                }
            }
            self.save(&registry)?;
            if action == "remove" {
                // Commit removal first. A cleanup failure cannot re-enable the plugin.
                let path = self.root.join("artifacts").join(id);
                if path.exists() {
                    fs::remove_dir_all(path)
                        .map_err(|e| format!("Plugin removed, but artifact cleanup failed: {e}"))?;
                }
            }
        }
        self.catalog()
    }
    pub fn reload(&self, id: &str) -> Result<Catalog> {
        self.reload_with_commit_hook(id, false, || {})
    }
    /// Reload a folder installation without changing its enabled state.
    /// An enabled plugin is replaced by the app's catalog observer.
    /// Changed host access is accepted without review, so this is for the
    /// operator's CLI; Settings uses `reload`, which keeps the review step.
    pub fn reload_live(&self, id: &str) -> Result<Catalog> {
        self.reload_with_commit_hook(id, true, || {})
    }
    fn reload_with_commit_hook(
        &self,
        id: &str,
        live: bool,
        before_commit: impl FnOnce(),
    ) -> Result<Catalog> {
        valid_id(id)?;
        if is_reserved(id) {
            return Err("Bundled plugins cannot be reloaded from disk".into());
        }
        let snapshot = {
            let _lock = self.lock()?;
            let registry = self.read()?;
            let plugin = registry
                .installed
                .get(id)
                .ok_or("Plugin is not installed")?;
            if plugin.enabled && !live {
                return Err("Disable the plugin before reloading it from disk".into());
            }
            let source = plugin
                .current_source
                .clone()
                .ok_or("Plugin was not installed from a reloadable folder")?;
            (
                plugin.current.clone(),
                source,
                plugin.manifest.id.clone(),
                plugin.manifest.host.clone().unwrap_or_default(),
            )
        };
        let release = prepare_reload_artifact(&snapshot.1)?;
        let artifact = release.artifact()?;
        let manifest = artifact.manifest.clone();
        let readme_revision = artifact.readme_revision();
        let icon_png_revision = icon_revision(artifact.icon_png.as_deref());
        let icon_jpg_revision = icon_revision(artifact.icon_jpg.as_deref());
        if manifest.id != snapshot.2 {
            return Err("Reloaded plugin manifest ID changed; import it as a new plugin".into());
        }
        // Compare effective access without changing the stored manifest representation.
        let effective_grants = |mut grants: HostGrants| {
            for command in &mut grants.commands {
                command.max_output_bytes = Some(
                    command
                        .max_output_bytes
                        .unwrap_or(DEFAULT_HOST_COMMAND_OUTPUT_BYTES),
                );
            }
            grants
        };
        if !live
            && effective_grants(manifest.host.clone().unwrap_or_default())
                != effective_grants(snapshot.3)
        {
            return Err("Host access changed; use Load from folder to review it".into());
        }
        let revision = hash(&release.bytes);
        before_commit();
        {
            let _lock = self.lock()?;
            let mut registry = self.read()?;
            let plugin = registry
                .installed
                .get_mut(id)
                .ok_or("Plugin is not installed")?;
            if plugin.enabled && !live {
                return Err("Disable the plugin before reloading it from disk".into());
            }
            if plugin.current != snapshot.0 || plugin.current_source.as_ref() != Some(&snapshot.1) {
                return Err("Plugin changed while reload was reading from disk; try again".into());
            }
            if let Some(previous) = &plugin.current_signature {
                if release.publisher().as_deref()
                    != Some(publisher_for_hash(&plugin.current, previous)?.as_str())
                {
                    return Err("Publisher changed or signed plugin became unsigned; remove and reinstall to change publisher".into());
                }
            }
            let (previous, previous_source) = if plugin.current == revision {
                (plugin.previous.clone(), plugin.previous_source.clone())
            } else {
                (Some(plugin.current.clone()), plugin.current_source.clone())
            };
            let previous_signature = if plugin.current == revision {
                plugin.previous_signature.clone()
            } else {
                plugin.current_signature.clone()
            };
            atomic_write(&self.artifact_path(&manifest.id, &revision), &release.bytes)?;
            plugin.manifest = manifest;
            plugin.current = revision;
            plugin.current_signature = release.signature;
            plugin.current_source = Some(snapshot.1);
            plugin.previous = previous;
            plugin.previous_signature = previous_signature;
            plugin.previous_source = previous_source;
            plugin.readme_revision = readme_revision;
            plugin.icon_png_revision = icon_png_revision;
            plugin.icon_jpg_revision = icon_jpg_revision;
            self.save(&registry)?;
        }
        self.catalog()
    }
    pub fn module(&self, id: &str, revision: &str) -> Result<String> {
        Ok(self.current_artifact(id, revision)?.code)
    }
    /// Read inert package content only when a details surface asks for it. This does not
    /// execute the plugin or add its potentially large content to the polled catalog.
    pub fn content(&self, id: &str, revision: &str) -> Result<PluginContent> {
        valid_id(id)?;
        valid_hash(revision)?;
        let _lock = self.lock()?;
        let registry = self.read()?;
        let plugin = registry
            .installed
            .get(id)
            .ok_or("Plugin is not installed")?;
        if plugin.current != revision {
            return Err("Plugin was updated; refresh the catalog".into());
        }
        let artifact = self.artifact(id, revision, plugin.current_signature.as_ref())?;
        Ok(PluginContent {
            readme: artifact.readme,
            icon_png: artifact.icon_png,
            icon_jpg: artifact.icon_jpg,
        })
    }
    pub fn host_grants(&self, id: &str, revision: &str) -> Result<HostGrants> {
        if revision == "bundled" {
            let plugin = self
                .catalog()?
                .plugins
                .into_iter()
                .find(|plugin| {
                    plugin.source == "bundled" && plugin.manifest.id == id && plugin.enabled
                })
                .ok_or("Bundled plugin is disabled or unavailable")?;
            return Ok(plugin.manifest.host.unwrap_or_default());
        }
        Ok(self
            .current_artifact(id, revision)?
            .manifest
            .host
            .unwrap_or_default())
    }
    fn current_artifact(&self, id: &str, revision: &str) -> Result<Artifact> {
        if self.safe_mode {
            return Err("External plugins are disabled in safe mode".into());
        }
        let _lock = self.lock()?;
        let r = self.read()?;
        let p = r.installed.get(id).ok_or("Plugin is not installed")?;
        if !p.enabled || p.current != revision {
            return Err("Plugin was disabled or updated; refresh the catalog".into());
        }
        self.artifact(id, revision, p.current_signature.as_ref())
    }
    pub fn recover(&self) -> Result<Catalog> {
        {
            let _lock = self.lock()?;
            let path = self.root.join("registry.json");
            if path.exists() {
                let mut backup = tempfile::Builder::new()
                    .prefix("registry-backup-")
                    .suffix(".json")
                    .tempfile_in(&self.root)
                    .map_err(err)?;
                std::io::copy(&mut File::open(&path).map_err(err)?, &mut backup).map_err(err)?;
                backup.as_file().sync_all().map_err(err)?;
                backup.keep().map_err(err)?;
            }
            let mut defaults = Registry::default();
            pin_bundled_defaults(&mut defaults, false);
            self.save(&defaults)?;
        }
        self.catalog()
    }
}
impl Release {
    fn artifact(&self) -> Result<Artifact> {
        if self.bytes.len() as u64 > LIMIT {
            return Err("Plugin artifact exceeds 8 MiB".into());
        }
        let artifact: Artifact = serde_json::from_slice(&self.bytes).map_err(err)?;
        artifact.manifest.validate()?;
        validate_readme(artifact.readme.as_deref())?;
        validate_icon(
            decode_icon(artifact.icon_png.as_deref())?.as_deref(),
            image::ImageFormat::Png,
        )?;
        validate_icon(
            decode_icon(artifact.icon_jpg.as_deref())?.as_deref(),
            image::ImageFormat::Jpeg,
        )?;
        if is_reserved(&artifact.manifest.id) || artifact.code.trim().is_empty() {
            return Err("Invalid plugin artifact".into());
        }
        // IMPORTANT: We allow unsigned plugins currently. Before release, we should add UI to restrict the public keys we trust; and also allowlist Block plugins.
        if let Some(signature) = &self.signature {
            if serde_json::to_vec(signature).map_err(err)?.len() > 64 * 1024 {
                return Err("Plugin release signature exceeds 64 KiB".into());
            }
            publisher(&self.bytes, signature)?;
        }
        Ok(artifact)
    }
    fn validate(&self) -> Result<Manifest> {
        Ok(self.artifact()?.manifest)
    }
    fn publisher(&self) -> Option<String> {
        self.signature.as_ref().map(|event| event.pubkey.to_hex())
    }
}
fn prepare_artifact(directory: &Path) -> Result<Release> {
    let root =
        cap_std::fs::Dir::open_ambient_dir(directory, cap_std::ambient_authority()).map_err(err)?;
    imports::read_package(&root, Path::new("."))
}
pub fn release_manifest(directory: &Path) -> Result<Manifest> {
    prepare_artifact(directory)?.validate()
}
fn prepare_reload_artifact(source: &InstallSource) -> Result<Release> {
    let InstallSource::Folder(source) = source else {
        return Err("Plugin was not installed from a reloadable folder".into());
    };
    let relative = validate_candidate_path(&source.path)?;
    if !fs::symlink_metadata(&source.root)
        .map_err(err)?
        .file_type()
        .is_dir()
    {
        return Err("Reload source root must be a regular folder".into());
    }
    let directory = cap_std::fs::Dir::open_ambient_dir(&source.root, cap_std::ambient_authority())
        .map_err(err)?;
    imports::read_package(&directory, &relative)
}
fn validate_candidate_path(path: &str) -> Result<PathBuf> {
    // Recorded paths are lossless folder identities; spaces are part of valid names.
    if path.is_empty() {
        return Err("Reload source path is empty".into());
    }
    if path == "." {
        return Ok(PathBuf::new());
    }
    let path = Path::new(path);
    if !path.is_relative() {
        return Err("Reload source path must be relative".into());
    }
    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(part) => relative.push(part),
            _ => return Err("Reload source path must stay inside its folder".into()),
        }
    }
    if relative.as_os_str().is_empty() {
        return Err("Reload source path is empty".into());
    }
    Ok(relative)
}
#[cfg(test)]
fn artifact_from_text(manifest: &str, code: String) -> Result<Vec<u8>> {
    artifact_from_parts(manifest, code, None, None, None)
}
fn artifact_from_parts(
    manifest: &str,
    code: String,
    readme: Option<String>,
    icon_png: Option<Vec<u8>>,
    icon_jpg: Option<Vec<u8>>,
) -> Result<Vec<u8>> {
    let manifest: Manifest = serde_json::from_str(manifest).map_err(err)?;
    manifest.validate()?;
    if is_reserved(&manifest.id) {
        return Err("Cannot replace a bundled plugin".into());
    }
    if code.trim().is_empty() {
        return Err("Plugin module is empty".into());
    }
    validate_readme(readme.as_deref())?;
    validate_icon(icon_png.as_deref(), image::ImageFormat::Png)?;
    validate_icon(icon_jpg.as_deref(), image::ImageFormat::Jpeg)?;
    let bytes = serde_json::to_vec(&Artifact {
        manifest,
        code,
        readme,
        icon_png: icon_png.map(|bytes| BASE64.encode(bytes)),
        icon_jpg: icon_jpg.map(|bytes| BASE64.encode(bytes)),
    })
    .map_err(err)?;
    if bytes.len() as u64 > LIMIT {
        return Err("Plugin artifact exceeds 8 MiB".into());
    }
    Ok(bytes)
}

fn validate_readme(readme: Option<&str>) -> Result<()> {
    if readme.is_some_and(|value| value.len() > MAX_README_BYTES) {
        return Err("README.md exceeds 256 KiB".into());
    }
    Ok(())
}

fn icon_reader(
    bytes: &[u8],
    format: image::ImageFormat,
) -> image::ImageReader<std::io::Cursor<&[u8]>> {
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_ICON_DIMENSION);
    limits.max_image_height = Some(MAX_ICON_DIMENSION);
    limits.max_alloc = Some(16 * 1024 * 1024);
    reader.limits(limits);
    reader
}

fn validate_icon(icon: Option<&[u8]>, format: image::ImageFormat) -> Result<()> {
    let Some(bytes) = icon else { return Ok(()) };
    let (name, kind) = match format {
        image::ImageFormat::Png => ("icon.png", "PNG"),
        image::ImageFormat::Jpeg => ("icon.jpg", "JPEG"),
        _ => return Err("Unsupported plugin icon format".into()),
    };
    if bytes.len() > MAX_ICON_BYTES {
        return Err(format!("{name} exceeds 1 MiB"));
    }
    if image::guess_format(bytes).ok() != Some(format) {
        return Err(format!("{name} must be a {kind} image"));
    }
    // Apply limits before parsing even the header: compressed PNG metadata can
    // expand independently of pixel dimensions.
    let decoded = icon_reader(bytes, format).decode().map_err(|_| {
        format!("{name} must be a valid {kind} image within dimensions and allocation limits")
    })?;
    let (width, height) = (decoded.width(), decoded.height());
    if width == 0
        || height == 0
        || width > MAX_ICON_DIMENSION
        || height > MAX_ICON_DIMENSION
        || u64::from(width) * u64::from(height) > MAX_ICON_PIXELS
    {
        return Err(format!(
            "{name} dimensions must be 1–4096 pixels per side and at most 1,048,576 pixels"
        ));
    }
    Ok(())
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn valid_hash(s: &str) -> Result<()> {
    if s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        Ok(())
    } else {
        Err("Invalid artifact revision".into())
    }
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn read_limited(path: &Path) -> Result<String> {
    if !fs::symlink_metadata(path)
        .map_err(err)?
        .file_type()
        .is_file()
    {
        return Err("Plugin files must be regular files, not symbolic links".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(err)?;
    if !file.metadata().map_err(err)?.is_file() {
        return Err("Plugin files must be regular files".into());
    }
    read_file_limited(file)
}
fn read_file_limited(file: File) -> Result<String> {
    let mut text = String::new();
    file.take(LIMIT + 1)
        .read_to_string(&mut text)
        .map_err(err)?;
    if text.len() as u64 > LIMIT {
        return Err("File exceeds 8 MiB".into());
    }
    Ok(text)
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("Missing parent directory")?;
    fs::create_dir_all(parent).map_err(err)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(err)?;
    temp.write_all(bytes).map_err(err)?;
    temp.as_file().sync_all().map_err(err)?;
    temp.persist(path).map_err(err)?;
    #[cfg(unix)]
    File::open(parent).map_err(err)?.sync_all().map_err(err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        artifact_from_text, bundled_manifests, enabled_by_default, validate_candidate_path,
        Manager, Manifest, Release, MAX_HOST_COMMAND_OUTPUT_BYTES,
    };
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::Path;

    #[test]
    fn compressed_png_profile_is_bounded_before_header_decode() {
        use image::{ImageDecoder as _, ImageEncoder as _};
        use std::io::Write as _;
        let mut png = vec![];
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&[0, 0, 0, 0], 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();
        let mut compressed = flate2::write::ZlibEncoder::new(vec![], flate2::Compression::best());
        for _ in 0..32 {
            compressed.write_all(&[0; 1024 * 1024]).unwrap();
        }
        let mut profile = b"profile\0\0".to_vec();
        profile.extend(compressed.finish().unwrap());
        let mut chunk = (profile.len() as u32).to_be_bytes().to_vec();
        chunk.extend(b"iCCP");
        chunk.extend(profile);
        let crc = crc32fast::hash(&chunk[4..]);
        chunk.extend(crc.to_be_bytes());
        png.splice(33..33, chunk); // Immediately after IHDR, before IDAT.
        assert!(png.len() < super::MAX_ICON_BYTES);

        // png ignores an over-budget optional profile. Verify it was discarded,
        // rather than inflated and retained, by the same bounded reader used in
        // validation. Removing the reader limits makes this assertion fail.
        let mut decoder = super::icon_reader(&png, image::ImageFormat::Png)
            .into_decoder()
            .unwrap();
        assert!(decoder.icc_profile().unwrap().is_none());
        super::validate_icon(Some(&png), image::ImageFormat::Png).unwrap();
    }

    #[test]
    fn native_catalog_matches_desktop_bundles() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../src/bundled");
        let index = fs::read_to_string(format!("{root}/index.ts")).unwrap();
        let mut dirs = BTreeMap::new();
        for line in index.lines() {
            if let Some(rest) = line.strip_prefix("import ") {
                if let Some((name, path)) = rest.split_once(" from \"./") {
                    if let Some(dir) = path.strip_suffix("/manifest.json\";") {
                        dirs.insert(name.to_string(), dir.to_string());
                    }
                }
            }
        }
        let mut expected = BTreeMap::new();
        for entry in index.split("manifest: { ...").skip(1) {
            let name = entry.split(',').next().unwrap();
            let default = entry
                .split("enabledByDefault: ")
                .nth(1)
                .unwrap()
                .starts_with("true");
            let manifest =
                fs::read_to_string(format!("{root}/{}/manifest.json", dirs[name])).unwrap();
            let manifest: Manifest = serde_json::from_str(&manifest).unwrap();
            expected.insert(manifest.id, default);
        }
        let native: BTreeMap<String, bool> = bundled_manifests()
            .into_iter()
            .map(|manifest| {
                let default = enabled_by_default(&manifest.id);
                (manifest.id, default)
            })
            .collect();
        assert_eq!(native, expected);

        let storage = fs::read_to_string(format!("{root}/../plugins/storage.ts")).unwrap();
        let mut browser_legacy_on: Vec<_> = storage
            .split("(existing && (")
            .nth(1)
            .expect("browser legacy-On condition")
            .split("))")
            .next()
            .unwrap()
            .split('"')
            .skip(1)
            .step_by(2)
            .collect();
        browser_legacy_on.sort_unstable();
        let mut upgraded = super::Registry::default();
        super::pin_bundled_defaults(&mut upgraded, true);
        let native_legacy_on: Vec<_> = upgraded
            .bundled_overrides
            .iter()
            .filter_map(|(id, enabled)| {
                (*enabled && !enabled_by_default(id)).then_some(id.as_str())
            })
            .collect();
        assert_eq!(
            native_legacy_on, browser_legacy_on,
            "legacy-On migration set"
        );

        let features =
            fs::read_to_string(format!("{root}/../app/conversation-features.ts")).unwrap();
        let manifests: BTreeMap<_, _> = features
            .lines()
            .filter_map(|line| {
                let (name, path) = line
                    .strip_prefix("import ")?
                    .split_once(" from \"../bundled/")?;
                let dir = path.strip_suffix("/manifest.json\";")?;
                let manifest = fs::read_to_string(format!("{root}/{dir}/manifest.json")).unwrap();
                let manifest: Manifest = serde_json::from_str(&manifest).unwrap();
                Some((name, manifest.id))
            })
            .collect();
        let mut host_ids: Vec<_> = features
            .split("manifest: { ...")
            .skip(1)
            .map(|entry| manifests[entry.split(',').next().unwrap()].as_str())
            .collect();
        host_ids.sort_unstable();
        let mut reserved_ids = super::BUILT_IN.to_vec();
        reserved_ids.sort_unstable();
        assert_eq!(reserved_ids, host_ids);
    }

    #[test]
    fn prebuilt_artifacts_cannot_claim_built_in_conversation_ids() {
        for id in ["buzz.emoji", "buzz.mentions"] {
            let release = Release {
                bytes: serde_json::to_vec(&serde_json::json!({
                    "manifest": { "id": id, "name": "Reserved feature", "apiVersion": 1 },
                    "code": "export function apply() {}"
                }))
                .unwrap(),
                signature: None,
            };
            assert_eq!(
                release.artifact().err().as_deref(),
                Some("Invalid plugin artifact")
            );
        }
    }

    #[test]
    fn legacy_manifest_and_code_artifacts_remain_compatible() {
        let release = Release {
            bytes: br#"{"manifest":{"id":"example.page","name":"Example","apiVersion":1},"code":"export function apply() {}"}"#.to_vec(),
            signature: None,
        };
        let artifact = release.artifact().unwrap();
        assert_eq!(artifact.manifest.id, "example.page");
        assert!(artifact.readme.is_none());
        assert!(artifact.icon_png.is_none());
        assert!(artifact.icon_jpg.is_none());
    }

    #[test]
    fn saved_human_identity_signs_importable_release_without_storage_fallback() {
        use buzz_credential_store::Error;
        use nostr::{
            key::{Keys, SecretKey},
            nips::nip19::ToBech32,
        };

        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("dist");
        fs::create_dir(&source).unwrap();
        fs::write(
            source.join("manifest.json"),
            r#"{"id":"example.saved","name":"Saved","apiVersion":1}"#,
        )
        .unwrap();
        fs::write(source.join("plugin.js"), "export const saved = true;").unwrap();
        for (error, expected) in [
            (Error::Absent, "Set up your Buzz human identity"),
            (Error::Denied, "access was denied"),
            (Error::Busy, "busy"),
            (Error::Corrupt, "malformed"),
            (Error::Unavailable, "could not be read"),
        ] {
            assert!(
                super::sign_release_from_store(&source, || Err::<Vec<u8>, _>(error))
                    .unwrap_err()
                    .contains(expected)
            );
            assert!(!source.join("plugin.artifact.json").exists());
        }
        for invalid in [
            b"not-an-nsec".to_vec(),
            vec![0xff],
            SecretKey::generate().to_secret_hex().into_bytes(),
        ] {
            assert!(super::sign_release_from_store(&source, || Ok(invalid))
                .unwrap_err()
                .contains("malformed"));
            assert!(!source.join("plugin.artifact.json").exists());
        }

        let key = SecretKey::generate();
        let nsec = key.to_bech32().unwrap();
        let publisher = super::sign_release_from_store(&source, || Ok(nsec.into_bytes())).unwrap();
        assert_eq!(publisher, Keys::new(key).public_key().to_hex());
        let event: nostr::event::Event =
            serde_json::from_slice(&fs::read(source.join("plugin.signature.json")).unwrap())
                .unwrap();
        assert_eq!(event.kind, super::RELEASE_KIND);
        assert_eq!(event.content, "");
        assert_eq!(event.tags.len(), 2);
        let prepared = crate::imports::prepare_folder(&source).unwrap();
        assert_eq!(
            prepared.preview.candidates[0].publisher.as_deref(),
            Some(publisher.as_str())
        );
        let home = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
        let path = prepared.preview.candidates[0].path.clone();
        let installed = prepared
            .install(&manager, &prepared.preview.token, &path)
            .unwrap();
        let plugin = installed
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.saved")
            .unwrap();
        assert_eq!(plugin.publisher.as_deref(), Some(publisher.as_str()));
        manager.change("enable", "example.saved").unwrap();
        assert!(manager
            .module("example.saved", &plugin.revision)
            .unwrap()
            .contains("saved = true"));
    }

    #[test]
    fn release_requires_valid_event_and_exact_artifact_bytes() {
        use super::{publisher, RELEASE_KIND, RELEASE_MARKER};
        use nostr::{
            event::{EventBuilder, FinalizeEvent, Kind, Tag},
            key::Keys,
        };
        let bytes = artifact_from_text(
            r#"{"id":"example.page","name":"Example","apiVersion":1}"#,
            "export const code = 1".into(),
        )
        .unwrap();
        let key = Keys::generate();
        let tags = || {
            vec![
                Tag::custom("x", [super::hash(&bytes)]),
                Tag::custom("t", [RELEASE_MARKER]),
            ]
        };
        let sign = |tags| {
            EventBuilder::new(RELEASE_KIND, "")
                .tags(tags)
                .finalize(&key)
                .unwrap()
        };
        let good = sign(tags());
        assert_eq!(publisher(&bytes, &good).unwrap(), good.pubkey.to_hex());
        let mut extra = tags();
        extra.push(Tag::custom("note", ["not authoritative"]));
        assert_eq!(
            publisher(&bytes, &sign(extra)).unwrap(),
            good.pubkey.to_hex()
        );
        for kind in [Kind::FileMetadata, Kind::TextNote] {
            let wrong_kind = EventBuilder::new(kind, "")
                .tags(tags())
                .finalize(&key)
                .unwrap();
            assert!(publisher(&bytes, &wrong_kind).is_err());
        }
        let nonempty = EventBuilder::new(RELEASE_KIND, "not empty")
            .tags(tags())
            .finalize(&key)
            .unwrap();
        assert!(publisher(&bytes, &nonempty).is_err());
        for altered in [
            artifact_from_text(
                r#"{"id":"example.page","name":"Changed","apiVersion":1}"#,
                "export const code = 1".into(),
            )
            .unwrap(),
            artifact_from_text(
                r#"{"id":"example.page","name":"Example","apiVersion":1}"#,
                "export const code = 2".into(),
            )
            .unwrap(),
        ] {
            assert!(publisher(&altered, &good).is_err());
        }
        let mut bad_id = good.clone();
        bad_id.id = "00".repeat(32).parse().unwrap();
        assert!(publisher(&bytes, &bad_id).is_err());
        let other = EventBuilder::new(RELEASE_KIND, "")
            .tags(tags())
            .finalize(&Keys::generate())
            .unwrap();
        let mut bad_sig = good.clone();
        bad_sig.sig = other.sig;
        assert!(publisher(&bytes, &bad_sig).is_err());
        for invalid in [
            {
                let mut t = tags();
                t.pop();
                t
            },
            {
                let mut t = tags();
                t.remove(0);
                t
            },
            {
                let mut t = tags();
                t[0] = Tag::custom("x", ["00".repeat(32)]);
                t
            },
            {
                let mut t = tags();
                t[0] = Tag::custom("x", [super::hash(&bytes).to_uppercase()]);
                t
            },
            {
                let mut t = tags();
                t[1] = Tag::custom("t", ["wrong-purpose"]);
                t
            },
            {
                let mut t = tags();
                t.push(t[0].clone());
                t
            },
            {
                let mut t = tags();
                t.push(t[1].clone());
                t
            },
            {
                let mut t = tags();
                t[0] = Tag::custom("x", [super::hash(&bytes), String::new()]);
                t
            },
            {
                let mut t = tags();
                t[1] = Tag::custom("t", Vec::<String>::new());
                t
            },
        ] {
            assert!(publisher(&bytes, &sign(invalid)).is_err());
        }
    }

    #[test]
    fn validates_discovery_metadata_and_old_manifests() {
        let old: Manifest =
            serde_json::from_str(r#"{"id":"example.page","name":"Example","apiVersion":1}"#)
                .unwrap();
        assert_eq!(old.description, None);
        assert_eq!(old.discovery, None);
        assert!(old.validate().is_ok());
        assert_eq!(
            serde_json::to_value(&old).unwrap(),
            serde_json::json!({"id":"example.page","name":"Example","apiVersion":1})
        );

        let manifest = serde_json::json!({
            "id": "example.page",
            "name": "Example",
            "apiVersion": 1,
            "description": "Reconcile invoices without leaving Buzz.",
            "discovery": {
                "category": "finance",
                "tags": ["accounting", "invoices"],
                "futureDisplayHint": true
            }
        });
        let parsed: Manifest = serde_json::from_value(manifest).unwrap();
        assert!(parsed.validate().is_ok());
        assert_eq!(
            parsed.description.as_deref(),
            Some("Reconcile invoices without leaving Buzz.")
        );
        assert_eq!(
            parsed.discovery.as_ref().unwrap().category.as_deref(),
            Some("finance")
        );
        assert_eq!(
            parsed.discovery.as_ref().unwrap().tags,
            ["accounting", "invoices"]
        );
        assert!(!serde_json::to_string(&parsed)
            .unwrap()
            .contains("futureDisplayHint"));

        for description in ["".into(), "   ".into(), "x".repeat(281)] {
            let mut invalid = parsed.clone();
            invalid.description = Some(description);
            assert!(invalid.validate().is_err());
        }
        for category in ["", "Finance", "finance_tools"] {
            let mut invalid = parsed.clone();
            invalid.discovery.as_mut().unwrap().category = Some(category.into());
            assert!(invalid.validate().is_err());
        }
        let mut duplicate = parsed.clone();
        duplicate.discovery.as_mut().unwrap().tags = vec!["finance".into(), "finance".into()];
        assert!(duplicate.validate().is_err());
        let mut too_many = parsed.clone();
        too_many.discovery.as_mut().unwrap().tags =
            (0..17).map(|index| format!("tag-{index}")).collect();
        assert!(too_many.validate().is_err());

        let unknown_top_level = serde_json::json!({
            "id": "example.page",
            "name": "Example",
            "apiVersion": 1,
            "futureSecurityField": true
        });
        assert!(serde_json::from_value::<Manifest>(unknown_top_level).is_err());
    }

    #[test]
    fn discovery_tags_accept_readable_text_and_preserve_display_spelling() {
        let text = serde_json::json!({
            "id": "example.page", "name": "Example", "apiVersion": 1,
            "discovery": {
                "category": "finance",
                "tags": ["Programming Language", "  Café  Tools  ", "编程", "C++", "🛠️"]
            }
        });
        let manifest: Manifest = serde_json::from_value(text.clone()).unwrap();
        assert!(manifest.validate().is_ok());
        assert_eq!(serde_json::to_value(&manifest).unwrap(), text);
        let bytes = artifact_from_text(&text.to_string(), "export const code = 1".into()).unwrap();
        let artifact: super::Artifact = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(artifact.manifest, manifest);

        for tag in ["x".repeat(80), "é".repeat(40)] {
            let mut valid = manifest.clone();
            valid.discovery.as_mut().unwrap().tags = vec![tag];
            assert!(valid.validate().is_ok());
        }
        for tag in [
            "".into(),
            "   ".into(),
            "\u{a0}".into(),
            "x".repeat(81),
            "é".repeat(41),
            "Programming\nLanguage".into(),
            "Programming\tLanguage".into(),
            "Bad\0Tag".into(),
            "Bad\u{7f}Tag".into(),
        ] {
            let mut invalid = manifest.clone();
            invalid.discovery.as_mut().unwrap().tags = vec![tag];
            assert!(invalid.validate().is_err());
        }
        for pair in [
            ["Programming Language", "programming language"],
            ["Programming Language", "  Programming   Language  "],
            ["Programming Language", "Programming\u{a0}Language"],
            ["Café", "CAFÉ"],
        ] {
            let mut duplicate = manifest.clone();
            duplicate.discovery.as_mut().unwrap().tags = pair.map(String::from).to_vec();
            assert!(duplicate.validate().is_err());
        }
    }

    #[test]
    fn validates_host_declarations_and_old_manifests() {
        let old: Manifest =
            serde_json::from_str(r#"{"id":"example.page","name":"Example","apiVersion":1}"#)
                .unwrap();
        assert_eq!(old.host, None);
        assert!(old.validate().is_ok());
        assert!(!serde_json::to_string(&old).unwrap().contains("host"));
        let manifest = serde_json::json!({
            "id": "example.page", "name": "Example", "apiVersion": 1,
            "host": {
                "commands": [{"id":"status","program":"example-cli","args":["status"]}],
                "networkOrigins": ["https://api.example.com"]
            }
        });
        assert!(artifact_from_text(&manifest.to_string(), "export const x = 1".into()).is_ok());
        let old: Manifest = serde_json::from_value(manifest.clone()).unwrap();
        assert_eq!(
            old.host.as_ref().unwrap().commands[0].max_output_bytes,
            None
        );
        assert_eq!(serde_json::to_value(&old).unwrap(), manifest);
        assert!(!old.host.as_ref().unwrap().managed_files);
        let mut managed = manifest.clone();
        managed["host"]["managedFiles"] = serde_json::json!(false);
        let parsed: Manifest = serde_json::from_value(managed.clone()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), manifest);
        managed["host"]["managedFiles"] = serde_json::json!(true);
        let parsed: Manifest = serde_json::from_value(managed.clone()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), managed);
        assert_ne!(
            artifact_from_text(&manifest.to_string(), "export const x = 1".into()).unwrap(),
            artifact_from_text(&managed.to_string(), "export const x = 1".into()).unwrap()
        );
        managed["host"]["managedFiles"] = serde_json::json!("true");
        assert!(serde_json::from_value::<Manifest>(managed).is_err());
        for limit in [1, 4096, MAX_HOST_COMMAND_OUTPUT_BYTES] {
            let mut valid = manifest.clone();
            valid["host"]["commands"][0]["maxOutputBytes"] = serde_json::json!(limit);
            assert!(artifact_from_text(&valid.to_string(), "export const x = 1".into()).is_ok());
        }
        for limit in [
            serde_json::json!(0),
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!(MAX_HOST_COMMAND_OUTPUT_BYTES + 1),
        ] {
            let mut invalid = manifest.clone();
            invalid["host"]["commands"][0]["maxOutputBytes"] = limit;
            assert!(artifact_from_text(&invalid.to_string(), "export const x = 1".into()).is_err());
        }
        assert_eq!(old.host.as_ref().unwrap().commands[0].max_input_bytes, None);
        for limit in [1, 4096, super::MAX_HOST_COMMAND_INPUT_BYTES] {
            let mut valid = manifest.clone();
            valid["host"]["commands"][0]["maxInputBytes"] = serde_json::json!(limit);
            assert!(artifact_from_text(&valid.to_string(), "export const x = 1".into()).is_ok());
        }
        for limit in [
            serde_json::json!(0),
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!(super::MAX_HOST_COMMAND_INPUT_BYTES + 1),
        ] {
            let mut invalid = manifest.clone();
            invalid["host"]["commands"][0]["maxInputBytes"] = limit;
            assert!(artifact_from_text(&invalid.to_string(), "export const x = 1".into()).is_err());
        }
        for invalid_origin in [
            "http://api.example.com",
            "https://api.example.com/path",
            "https://user@api.example.com",
            "https://api.example.com:443",
        ] {
            let mut invalid = manifest.clone();
            invalid["host"]["networkOrigins"] = serde_json::json!([invalid_origin]);
            assert!(artifact_from_text(&invalid.to_string(), "export const x = 1".into()).is_err());
        }
        let mut invalid = manifest.clone();
        invalid["host"]["commands"][0]["program"] = serde_json::json!("/bin/sh");
        assert!(artifact_from_text(&invalid.to_string(), "export const x = 1".into()).is_err());
        let mut invalid = manifest.clone();
        invalid["host"]["commands"]
            .as_array_mut()
            .unwrap()
            .push(manifest["host"]["commands"][0].clone());
        assert!(artifact_from_text(&invalid.to_string(), "export const x = 1".into()).is_err());

        let mut processes = manifest.clone();
        processes["host"]["processes"] = serde_json::json!([
            {"id":"agent","program":"example-cli"},
            {"id":"install","program":"bash","args":["-c","echo install"]}
        ]);
        assert!(artifact_from_text(&processes.to_string(), "export const x = 1".into()).is_ok());
        let parsed: Manifest = serde_json::from_value(processes.clone()).unwrap();
        assert_eq!(
            parsed.host.as_ref().unwrap().processes[0].args,
            Vec::<String>::new()
        );
        assert!(!parsed.host.as_ref().unwrap().processes[0].bundled);
        let mut bundled = processes.clone();
        bundled["host"]["processes"][0]["bundled"] = serde_json::json!(true);
        let parsed: Manifest = serde_json::from_value(bundled).unwrap();
        assert!(parsed.host.as_ref().unwrap().processes[0].bundled);
        let hash = "a".repeat(64);
        let mut artifact = processes.clone();
        artifact["host"]["processes"][0]["artifact"] = serde_json::json!({
            "path": std::env::temp_dir().join("example-cli"), "sha256": hash,
            "siblings": [{"name": "runtime.js", "sha256": "b".repeat(64)}]
        });
        assert!(artifact_from_text(&artifact.to_string(), "export const x = 1".into()).is_ok());
        let mut home = artifact.clone();
        home["host"]["processes"][0]["artifact"]["path"] = serde_json::json!("~/agent/cli");
        assert!(artifact_from_text(&home.to_string(), "export const x = 1".into()).is_ok());
        for (field, value) in [
            ("path", serde_json::json!("relative/agent")),
            ("path", serde_json::json!("~agent/cli")),
            ("sha256", serde_json::json!("A".repeat(64))),
            ("sha256", serde_json::json!("a".repeat(63))),
            (
                "siblings",
                serde_json::json!([{"name": "../other", "sha256": "b".repeat(64)}]),
            ),
        ] {
            let mut invalid = artifact.clone();
            invalid["host"]["processes"][0]["artifact"][field] = value;
            assert!(artifact_from_text(&invalid.to_string(), "export const x = 1".into()).is_err());
        }
        let sibling = |name: String| serde_json::json!({"name":name,"sha256":"b".repeat(64)});
        for (siblings, valid) in [
            (
                (0..16)
                    .map(|i| sibling(format!("file-{i}")))
                    .collect::<Vec<_>>(),
                true,
            ),
            (
                (0..17).map(|i| sibling(format!("file-{i}"))).collect(),
                false,
            ),
            (
                vec![sibling("duplicate".into()), sibling("duplicate".into())],
                false,
            ),
            (vec![sibling("a".repeat(80))], true),
            (vec![sibling("a".repeat(81))], false),
        ]
        .into_iter()
        .chain(["", ".", "..", "nul\0name"].map(|name| (vec![sibling(name.into())], false)))
        {
            let mut candidate = artifact.clone();
            candidate["host"]["processes"][0]["artifact"]["siblings"] = serde_json::json!(siblings);
            assert_eq!(
                artifact_from_text(&candidate.to_string(), "export const x = 1".into()).is_ok(),
                valid
            );
        }
        let prefix = std::env::temp_dir()
            .join("artifact-")
            .to_string_lossy()
            .into_owned();
        for (path, valid) in [
            (format!("{prefix}{}", "x".repeat(4096 - prefix.len())), true),
            (
                format!("{prefix}{}", "x".repeat(4097 - prefix.len())),
                false,
            ),
            (format!("{prefix}\0name"), false),
        ] {
            let mut candidate = artifact.clone();
            candidate["host"]["processes"][0]["artifact"]["path"] = serde_json::json!(path);
            assert_eq!(
                artifact_from_text(&candidate.to_string(), "export const x = 1".into()).is_ok(),
                valid
            );
        }
        let mut invalid = artifact.clone();
        invalid["host"]["processes"][0]["bundled"] = serde_json::json!(true);
        assert!(artifact_from_text(&invalid.to_string(), "export const x = 1".into()).is_err());
        for (field, value) in [
            ("program", serde_json::json!("/bin/sh")),
            ("program", serde_json::json!("")),
            ("id", serde_json::json!("Agent")),
            ("args", serde_json::json!(["a\0b"])),
            ("shell", serde_json::json!(true)),
        ] {
            let mut invalid = processes.clone();
            invalid["host"]["processes"][0][field] = value;
            assert!(artifact_from_text(&invalid.to_string(), "export const x = 1".into()).is_err());
        }
        let mut duplicate = processes.clone();
        duplicate["host"]["processes"][1]["id"] = serde_json::json!("agent");
        assert!(artifact_from_text(&duplicate.to_string(), "export const x = 1".into()).is_err());
    }

    #[test]
    fn host_grants_follow_enabled_current_artifact() {
        let temp = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(temp.path().into()), "test", false).unwrap();
        let source = temp.path().join("build");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        fs::write(
            source.join("manifest.json"),
            r#"{"id":"example.page","name":"Example","apiVersion":1,"host":{"commands":[{"id":"first","program":"example-cli","args":["status"]}],"networkOrigins":["https://one.example"]}}"#,
        )
        .unwrap();
        let first = manager
            .install(&source)
            .unwrap()
            .plugins
            .into_iter()
            .find(|plugin| plugin.manifest.id == "example.page")
            .unwrap()
            .revision;
        assert!(manager.host_grants("example.page", &first).is_err());
        manager.change("enable", "example.page").unwrap();
        assert!(manager.host_grants("example.page", "bundled").is_err());
        let paused = Manager::open(Some(temp.path().into()), "test", true).unwrap();
        assert!(paused.host_grants("example.page", &first).is_err());
        assert_eq!(
            manager
                .host_grants("example.page", &first)
                .unwrap()
                .commands[0]
                .id,
            "first"
        );

        fs::write(
            source.join("manifest.json"),
            r#"{"id":"example.page","name":"Example","apiVersion":1,"host":{"commands":[{"id":"second","program":"example-cli","args":["status","--json"],"maxOutputBytes":65536}],"networkOrigins":["https://two.example"],"managedFiles":true}}"#,
        )
        .unwrap();
        let second = manager
            .install(&source)
            .unwrap()
            .plugins
            .into_iter()
            .find(|plugin| plugin.manifest.id == "example.page")
            .unwrap()
            .revision;
        assert!(manager.host_grants("example.page", &first).is_err());
        let grants = manager.host_grants("example.page", &second).unwrap();
        assert!(grants.managed_files);
        assert_eq!(grants.commands[0].id, "second");
        assert_eq!(grants.commands[0].max_output_bytes, Some(65536));
        let reopened = Manager::open(Some(temp.path().into()), "test", false).unwrap();
        assert_eq!(
            reopened.host_grants("example.page", &second).unwrap(),
            grants
        );
        assert_eq!(grants.network_origins, ["https://two.example"]);
        manager.change("disable", "example.page").unwrap();
        assert!(manager.host_grants("example.page", &second).is_err());
    }

    #[test]
    fn apps_deploy_to_the_sign_in_tenant_only() {
        assert_eq!(
            super::apps_control_plane("https://app.builderlab.xyz"),
            Some("https://compose-ctrl.builderlab.xyz")
        );
        assert_eq!(
            super::apps_control_plane("https://app.builderlabstaging.xyz"),
            Some("https://compose-ctrl.builderlabstaging.xyz")
        );
        assert_eq!(
            super::apps_control_plane("https://block.builderlab.xyz"),
            Some("https://compose-ctrl.block.builderlab.xyz")
        );
        assert_eq!(
            super::apps_control_plane("https://builderlab.example"),
            None
        );
    }

    #[test]
    fn host_grants_follow_enabled_bundled_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(temp.path().into()), "test", false).unwrap();
        let grants = manager.host_grants("block.builderlab", "bundled").unwrap();
        if env!("BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG").is_empty() {
            assert_eq!(
                grants.files,
                super::apps_control_plane(super::BUILDERLAB_ORIGIN).is_some()
            );
            assert_eq!(
                grants.network_origins,
                if env!("BUZZ_BUILDERLAB_ORIGIN").is_empty() {
                    vec![]
                } else {
                    std::iter::once(env!("BUZZ_BUILDERLAB_ORIGIN"))
                        .chain(super::apps_control_plane(env!("BUZZ_BUILDERLAB_ORIGIN")))
                        .map(str::to_owned)
                        .collect()
                }
            );
            assert_eq!(grants.federated_identity, None);
        } else {
            // An FI build grants only the native session's Builderlab routes.
            assert!(!grants.files);
            assert!(grants.network_origins.is_empty());
            let grant = grants.federated_identity.clone().unwrap();
            let base = super::BUILDERLAB_API_BASE_PATH;
            let operations: Vec<_> = grant
                .operations
                .iter()
                .map(|op| format!("{} {}", op.method, op.path))
                .collect();
            assert!(operations.contains(&format!("GET {base}v1/auth/me")));
            assert!(operations.contains(&format!("POST {base}v3/beekeeper/register-agent")));
            assert!(operations.contains(&format!("POST {base}v1/buzz/nsec-backups/status")));
            assert_eq!(operations.len(), super::BUILDERLAB_FI_ROUTES.len());
        }
        assert!(grants.commands.is_empty());
        assert!(manager
            .host_grants("block.builderlab", "wrong-revision")
            .is_err());
        assert!(manager.host_grants("unknown.plugin", "bundled").is_err());
        assert_eq!(
            manager.host_grants("buzz.channels", "bundled").unwrap(),
            super::HostGrants::default()
        );

        manager.change("disable", "block.builderlab").unwrap();
        let reopened = Manager::open(Some(temp.path().into()), "test", false).unwrap();
        assert!(reopened.host_grants("block.builderlab", "bundled").is_err());
        manager.change("enable", "block.builderlab").unwrap();
        assert_eq!(
            reopened.host_grants("block.builderlab", "bundled").unwrap(),
            grants
        );

        // Safe mode pauses external plugins; enabled bundled plugins remain usable.
        let paused = Manager::open(Some(temp.path().into()), "test", true).unwrap();
        assert_eq!(
            paused.host_grants("block.builderlab", "bundled").unwrap(),
            grants
        );
    }

    #[test]
    fn reload_rejects_changed_host_grants_before_enable() {
        let temp = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(temp.path().into()), "test", false).unwrap();
        let source = temp.path().join("build");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        fs::write(
            source.join("manifest.json"),
            r#"{"id":"example.page","name":"Example","apiVersion":1}"#,
        )
        .unwrap();
        let first = manager
            .install(&source)
            .unwrap()
            .plugins
            .iter()
            .find(|plugin| plugin.manifest.id == "example.page")
            .unwrap()
            .revision
            .clone();

        fs::write(
            source.join("manifest.json"),
            r#"{"id":"example.page","name":"Example","apiVersion":1,"host":{"commands":[{"id":"status","program":"example-cli","args":["status"]}]}}"#,
        )
        .unwrap();
        let error = match manager.reload("example.page") {
            Ok(_) => panic!("reload should reject changed host grants"),
            Err(error) => error,
        };
        assert!(error.contains("Load from folder"));

        fs::write(
            source.join("manifest.json"),
            r#"{"id":"example.page","name":"Example","apiVersion":1,"host":{"managedFiles":true}}"#,
        )
        .unwrap();
        assert!(manager
            .reload("example.page")
            .err()
            .unwrap()
            .contains("Load from folder"));
        let catalog = manager.catalog().unwrap();
        let plugin = catalog
            .plugins
            .iter()
            .find(|plugin| plugin.manifest.id == "example.page")
            .unwrap();
        assert_eq!(plugin.revision, first);
        assert!(plugin.previous.is_none());
        manager.change("enable", "example.page").unwrap();
        assert!(manager
            .host_grants("example.page", &first)
            .unwrap()
            .commands
            .is_empty());
    }

    #[test]
    fn huddles_are_available_on_desktop_and_can_be_disabled() {
        let temp = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(temp.path().into()), "huddles-test", false).unwrap();
        let huddles = || {
            manager
                .catalog()
                .unwrap()
                .plugins
                .into_iter()
                .find(|plugin| plugin.manifest.id == "buzz.huddles")
                .expect("Desktop must expose the Huddles plugin")
        };
        assert!(huddles().enabled);
        manager.change("disable", "buzz.huddles").unwrap();
        assert!(!huddles().enabled);
        manager.change("enable", "buzz.huddles").unwrap();
        assert!(huddles().enabled);
    }

    #[test]
    fn optional_plugins_default_off_and_preserve_explicit_overrides() {
        let id = "buzz.todos";
        let temp = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(temp.path().into()), "optional-test", false).unwrap();
        let enabled = |manager: &Manager| {
            manager
                .catalog()
                .unwrap()
                .plugins
                .into_iter()
                .find(|plugin| plugin.manifest.id == id)
                .unwrap()
                .enabled
        };
        assert!(!enabled(&manager), "{id} defaults off");
        manager.change("enable", id).unwrap();
        let reopened = Manager::open(Some(temp.path().into()), "optional-test", false).unwrap();
        assert!(enabled(&reopened), "{id} retains enable after reopening");
        reopened.change("disable", id).unwrap();
        assert!(!enabled(&manager), "{id} exposes persisted disable");
    }

    #[test]
    fn agents_migrates_its_switch_and_ignores_v1s() {
        let open = |overrides: serde_json::Value| {
            let temp = tempfile::tempdir().unwrap();
            let profile = temp.path().join("profiles").join("agents");
            fs::create_dir_all(&profile).unwrap();
            let registry = serde_json::json!({
                "version": 1,
                "bundledEnabled": true,
                "bundledOverrides": overrides,
                "installed": {},
            });
            fs::write(profile.join("registry.json"), registry.to_string()).unwrap();
            let manager = Manager::open(Some(temp.path().into()), "agents", false).unwrap();
            (temp, manager)
        };
        let enabled = |manager: &Manager| {
            manager
                .catalog()
                .unwrap()
                .plugins
                .into_iter()
                .find(|plugin| plugin.manifest.id == "buzz.agents")
                .unwrap()
                .enabled
        };
        let (_v1, manager) = open(serde_json::json!({ "buzz.agents": false }));
        assert!(enabled(&manager), "v1's switch does not turn Agents off");
        let (_temp, manager) = open(serde_json::json!({ "buzz.agents2": false }));
        assert!(!enabled(&manager), "the Agents2 switch still applies");
        manager.change("enable", "buzz.agents").unwrap();
        assert!(enabled(&manager));
        let reopened = Manager::open(Some(_temp.path().into()), "agents", false).unwrap();
        assert!(enabled(&reopened), "reopening keeps the new preference");
        reopened.change("disable", "buzz.agents").unwrap();
        assert!(!enabled(&manager), "migration does not reset later changes");
        reopened.change("enable", "buzz.agents").unwrap();
        let saved: serde_json::Value = serde_json::from_slice(
            &fs::read(manager.storage_root().join("registry.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(saved["bundledOverrides"]["buzz.agents"], true);
        assert!(saved["bundledOverrides"].get("buzz.agents2").is_none());
    }

    #[test]
    fn formerly_installed_agent_plugins_upgrade_to_the_bundled_copy() {
        let manifest: serde_json::Value = serde_json::from_str(include_str!(
            "../../../src/bundled/claude-code/manifest.json"
        ))
        .unwrap();
        let installed = |id: &str, enabled: bool| {
            let mut manifest = manifest.clone();
            manifest["id"] = id.into();
            serde_json::json!({
                "manifest": manifest,
                "current": "0".repeat(64),
                "previous": null,
                "enabled": enabled,
            })
        };
        let open = |installed: serde_json::Value| {
            let temp = tempfile::tempdir().unwrap();
            let profile = temp.path().join("profiles").join("upgrade");
            fs::create_dir_all(&profile).unwrap();
            let registry = serde_json::json!({
                "version": 1,
                "bundledEnabled": true,
                "bundledOverrides": { "buzz.todos": true },
                "installed": installed,
            });
            fs::write(profile.join("registry.json"), registry.to_string()).unwrap();
            let manager = Manager::open(Some(temp.path().into()), "upgrade", false).unwrap();
            (temp, manager)
        };
        let enabled = |manager: &Manager, id: &str| {
            let plugins: Vec<_> = manager
                .catalog()
                .unwrap()
                .plugins
                .into_iter()
                .filter(|plugin| plugin.manifest.id == id)
                .collect();
            assert_eq!(plugins.len(), 1, "{id} listed once");
            assert_eq!(plugins[0].source, "bundled");
            plugins[0].enabled
        };

        for id in super::FORMERLY_INSTALLED {
            for was_enabled in [true, false] {
                let (_temp, manager) =
                    open(serde_json::json!({ (*id): installed(id, was_enabled) }));
                assert_eq!(enabled(&manager, id), was_enabled);
                assert!(enabled(&manager, "buzz.todos"), "other overrides survive");
                manager.change("enable", id).unwrap();
                assert!(enabled(&manager, id));
                manager.change("disable", id).unwrap();
                assert!(!enabled(&manager, id));
            }
        }

        let (_temp, manager) =
            open(serde_json::json!({ "buzz.terminal": installed("buzz.terminal", true) }));
        assert_eq!(
            manager.catalog().err().as_deref(),
            Some("Invalid installed plugin identity")
        );
    }

    #[test]
    fn reload_source_paths_keep_spaces_and_reject_escapes() {
        for path in [" plugin", "plugin ", "a/ b /c", " "] {
            assert_eq!(validate_candidate_path(path).unwrap(), Path::new(path));
        }
        assert_eq!(validate_candidate_path(".").unwrap(), Path::new(""));
        for path in ["", "/plugin", "../plugin", "a/../b", "./plugin"] {
            assert!(validate_candidate_path(path).is_err(), "{path:?}");
        }
    }

    #[test]
    fn reload_rejects_enable_between_disk_read_and_commit() {
        let temp = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(temp.path().into()), "test", false).unwrap();
        let source = temp.path().join("build");
        fs::create_dir(&source).unwrap();
        fs::write(
            source.join("manifest.json"),
            r#"{"id":"example.page","name":"Example","apiVersion":1}"#,
        )
        .unwrap();
        fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        let first = manager
            .install(&source)
            .unwrap()
            .plugins
            .iter()
            .find(|plugin| plugin.manifest.id == "example.page")
            .unwrap()
            .revision
            .clone();
        fs::write(source.join("plugin.js"), "export const reloaded = true;").unwrap();

        let error = match manager.reload_with_commit_hook("example.page", false, || {
            manager.change("enable", "example.page").unwrap();
        }) {
            Ok(_) => panic!("reload should reject an enabled plugin at commit"),
            Err(error) => error,
        };

        assert!(error.contains("Disable the plugin before reloading"));
        let catalog = manager.catalog().unwrap();
        let plugin = catalog
            .plugins
            .iter()
            .find(|plugin| plugin.manifest.id == "example.page")
            .unwrap();
        assert!(plugin.enabled);
        assert_eq!(plugin.revision, first);
        assert_eq!(plugin.previous, None);
    }
    #[test]
    fn validates_agent_hook_grants() {
        for (keys, valid) in [
            (vec!["buzz.pi/pi"], true),
            (vec!["buzz.pi/pi", "buzz.codex/codex"], true),
            (vec!["pi"], false),
            (vec!["buzz.pi/pi", "buzz.pi/pi"], false),
            (vec!["buzz.pi/../pi"], false),
        ] {
            let manifest: super::Manifest = serde_json::from_value(serde_json::json!({
                "id": "policy", "name": "Policy", "apiVersion": 1,
                "host": { "agentHooks": keys },
            }))
            .unwrap();
            assert_eq!(manifest.validate().is_ok(), valid);
        }
    }
}
