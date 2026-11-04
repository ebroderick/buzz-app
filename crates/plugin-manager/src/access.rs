//! Repository access rules: a local JSON file, beside the profile folders, that says which
//! repository sources Git reads over which SSH user and agent socket. Imports never read the
//! user's Git or SSH configuration, so this file is the only way to declare such access.
//! A rule can change only the scheme, the SSH user and the agent socket; the host, port and
//! path stay as the user entered them.
use crate::{managed::read_file, Result};
use serde_json::{Map, Value};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

pub const FILE_NAME: &str = "repository-access.json";
pub const PATH_ENV: &str = "BUZZ_REPOSITORY_ACCESS";
const MAX_BYTES: u64 = 64 * 1024;
const MAX_RULES: usize = 32;
const MAX_PROBLEMS: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Macos,
    Linux,
    Windows,
}
impl Platform {
    pub fn current() -> Option<Self> {
        if cfg!(target_os = "macos") {
            Some(Self::Macos)
        } else if cfg!(target_os = "linux") {
            Some(Self::Linux)
        } else if cfg!(windows) {
            Some(Self::Windows)
        } else {
            None
        }
    }
    fn parse(name: &str) -> Option<Self> {
        match name {
            "macos" => Some(Self::Macos),
            "linux" => Some(Self::Linux),
            "windows" => Some(Self::Windows),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Rule {
    host: String,
    path_prefix: String,
    ssh_user: String,
    ssh_agent_socket: Option<String>,
    rewrite_https: bool,
    /// `None` applies on every platform.
    platforms: Option<Vec<Platform>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    Absent,
    /// The file as a whole cannot be used; only the built-in rules apply.
    Invalid {
        reason: String,
    },
    Ready,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccessRules {
    rules: Vec<Rule>,
    pub problems: Vec<String>,
    pub path: Option<PathBuf>,
    pub status: Status,
}

/// Square's macOS SSH setup selects this agent through SSH config, which imports do not
/// read, so the rule ships with Buzz.
fn built_in_rules() -> Vec<Rule> {
    vec![Rule {
        host: "github.com".into(),
        path_prefix: "/squareup/".into(),
        ssh_user: "org-49461806".into(),
        ssh_agent_socket: Some("~/Library/Application Support/block-ssh-agent/agent.sock".into()),
        rewrite_https: true,
        platforms: Some(vec![Platform::Macos]),
    }]
}

pub fn built_in() -> AccessRules {
    AccessRules {
        rules: built_in_rules(),
        problems: vec![],
        path: None,
        status: Status::Absent,
    }
}

/// `BUZZ_REPOSITORY_ACCESS` when set, otherwise the file beside the profile folders. Never
/// fails: an unusable file leaves the built-in rules in place and reports why.
pub fn load(root: &Path, env: Option<OsString>) -> AccessRules {
    let mut access = built_in();
    let path = match env.filter(|value| !value.is_empty()) {
        Some(value) if Path::new(&value).is_absolute() => PathBuf::from(value),
        Some(_) => {
            access.status = Status::Invalid {
                reason: format!("{PATH_ENV} must be an absolute path"),
            };
            return access;
        }
        None => root.join(FILE_NAME),
    };
    access.path = Some(path.clone());
    let parsed = match read_file(&path, "Repository access file", MAX_BYTES) {
        Ok(None) => return access,
        Ok(Some(text)) => parse(&text),
        Err(reason) => Err(reason),
    };
    match parsed {
        Ok(file) => {
            access.rules = file.rules;
            if file.built_in_rules {
                access.rules.extend(built_in_rules());
            }
            access.problems = file.problems;
            access.status = Status::Ready;
        }
        Err(reason) => access.status = Status::Invalid { reason },
    }
    access
}

struct File {
    rules: Vec<Rule>,
    built_in_rules: bool,
    problems: Vec<String>,
}

fn parse(text: &str) -> Result<File> {
    let value: Value = serde_json::from_str(text).map_err(|e| format!("Invalid JSON: {e}"))?;
    let Value::Object(mut root) = value else {
        return Err("Expected a JSON object".into());
    };
    match root.remove("version") {
        Some(Value::Number(version)) if version.as_u64() == Some(1) => {}
        Some(_) => return Err("Unsupported version; this Buzz reads version 1".into()),
        None => return Err("Missing version".into()),
    }
    let built_in_rules = match root.remove("builtInRules") {
        None => true,
        Some(Value::Bool(value)) => value,
        Some(_) => return Err("builtInRules must be true or false".into()),
    };
    let entries = match root.remove("rules") {
        None => vec![],
        Some(Value::Array(entries)) => entries,
        Some(_) => return Err("rules must be an array".into()),
    };
    let mut problems = vec![];
    let mut report = |message: String| {
        if problems.len() < MAX_PROBLEMS {
            problems.push(message);
        }
    };
    if entries.len() > MAX_RULES {
        report(format!(
            "Only the first {MAX_RULES} of {} rules are used",
            entries.len()
        ));
    }
    let mut rules = vec![];
    for (index, entry) in entries.into_iter().take(MAX_RULES).enumerate() {
        match parse_rule(entry) {
            Ok(rule) => rules.push(rule),
            Err(reason) => report(format!("Rule {}: {reason}", index + 1)),
        }
    }
    Ok(File {
        rules,
        built_in_rules,
        problems,
    })
}

fn parse_rule(entry: Value) -> Result<Rule> {
    let Value::Object(mut entry) = entry else {
        return Err("expected an object".into());
    };
    let host = required(&mut entry, "host")?;
    if host.len() > 253
        || host.starts_with('-')
        || !host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
    {
        return Err("host must be a lowercase host name without a port".into());
    }
    let path_prefix = required(&mut entry, "pathPrefix")?;
    if path_prefix.len() > 256
        || !path_prefix.starts_with('/')
        || !path_prefix.ends_with('/')
        || path_prefix.contains('%')
        || path_prefix.split('/').any(|segment| segment == "..")
        || path_prefix
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(
            "pathPrefix must start and end with / and contain no %, .. segment or whitespace"
                .into(),
        );
    }
    let ssh_user = required(&mut entry, "sshUser")?;
    if ssh_user.len() > 64
        || ssh_user.starts_with('-')
        || !ssh_user
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
    {
        return Err("sshUser must be 1 to 64 letters, digits, dots, underscores or hyphens, not starting with a hyphen".into());
    }
    let ssh_agent_socket = match entry.remove("sshAgentSocket") {
        None => None,
        Some(Value::String(socket))
            if (Path::new(&socket).is_absolute() || socket.starts_with("~/"))
                && !socket.chars().any(char::is_control) =>
        {
            Some(socket)
        }
        Some(_) => return Err("sshAgentSocket must be an absolute path or start with ~/".into()),
    };
    if ssh_agent_socket.is_some() && cfg!(windows) {
        return Err("sshAgentSocket is not supported on Windows".into());
    }
    let rewrite_https = match entry.remove("rewriteHttps") {
        None => true,
        Some(Value::Bool(value)) => value,
        Some(_) => return Err("rewriteHttps must be true or false".into()),
    };
    let platforms = match entry.remove("platforms") {
        None => None,
        Some(Value::Array(names)) if !names.is_empty() => Some(
            names
                .iter()
                .map(|name| name.as_str().and_then(Platform::parse))
                .collect::<Option<Vec<_>>>()
                .ok_or("platforms must list only macos, linux or windows")?,
        ),
        Some(_) => return Err("platforms must list macos, linux or windows".into()),
    };
    Ok(Rule {
        host,
        path_prefix,
        ssh_user,
        ssh_agent_socket,
        rewrite_https,
        platforms,
    })
}

fn required(entry: &mut Map<String, Value>, key: &str) -> Result<String> {
    match entry.remove(key) {
        Some(Value::String(value)) if !value.is_empty() => Ok(value),
        _ => Err(format!("{key} is required and must be a string")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn rule(host: &str, prefix: &str, user: &str) -> Rule {
        Rule {
            host: host.into(),
            path_prefix: prefix.into(),
            ssh_user: user.into(),
            ssh_agent_socket: None,
            rewrite_https: true,
            platforms: None,
        }
    }
    fn problems(text: &str) -> Vec<String> {
        parse(text).unwrap().problems
    }

    #[test]
    fn built_in_rule_is_the_square_macos_agent() {
        let access = built_in();
        assert_eq!(access.status, Status::Absent);
        assert_eq!(
            access.rules,
            vec![Rule {
                host: "github.com".into(),
                path_prefix: "/squareup/".into(),
                ssh_user: "org-49461806".into(),
                ssh_agent_socket: Some(
                    "~/Library/Application Support/block-ssh-agent/agent.sock".into()
                ),
                rewrite_https: true,
                platforms: Some(vec![Platform::Macos]),
            }]
        );
    }

    #[test]
    fn parses_every_field_and_defaults() {
        let file = parse(
            r#"{"version": 1, "unknown": 0, "rules": [
                {"host": "git.example.com", "pathPrefix": "/team/", "sshUser": "git",
                 "sshAgentSocket": "/run/agent.sock", "rewriteHttps": false,
                 "platforms": ["linux", "macos"], "note": "ignored"},
                {"host": "github.com", "pathPrefix": "/example-org/", "sshUser": "git"}
            ]}"#,
        )
        .unwrap();
        assert!(file.problems.is_empty(), "{:?}", file.problems);
        assert!(file.built_in_rules);
        let mut first = rule("git.example.com", "/team/", "git");
        first.ssh_agent_socket = Some("/run/agent.sock".into());
        first.rewrite_https = false;
        first.platforms = Some(vec![Platform::Linux, Platform::Macos]);
        assert_eq!(
            file.rules,
            vec![first, rule("github.com", "/example-org/", "git")]
        );
        if !cfg!(windows) {
            let home = parse(r#"{"version": 1, "rules": [{"host": "github.com", "pathPrefix": "/a/", "sshUser": "git", "sshAgentSocket": "~/agent.sock"}]}"#).unwrap();
            assert_eq!(
                home.rules[0].ssh_agent_socket.as_deref(),
                Some("~/agent.sock")
            );
        }
        assert!(
            !parse(r#"{"version": 1, "builtInRules": false}"#)
                .unwrap()
                .built_in_rules
        );
    }

    #[test]
    fn each_invalid_field_drops_only_its_rule() {
        let valid = r#"{"host": "github.com", "pathPrefix": "/ok/", "sshUser": "git"}"#;
        for (invalid, field) in [
            (r#"[]"#, "object"),
            (r#"{"pathPrefix": "/a/", "sshUser": "git"}"#, "host"),
            (
                r#"{"host": "GitHub.com", "pathPrefix": "/a/", "sshUser": "git"}"#,
                "host",
            ),
            (
                r#"{"host": "github.com:22", "pathPrefix": "/a/", "sshUser": "git"}"#,
                "host",
            ),
            (
                r#"{"host": "git%68ub.com", "pathPrefix": "/a/", "sshUser": "git"}"#,
                "host",
            ),
            (
                r#"{"host": "-github.com", "pathPrefix": "/a/", "sshUser": "git"}"#,
                "host",
            ),
            (
                r#"{"host": "", "pathPrefix": "/a/", "sshUser": "git"}"#,
                "host",
            ),
            (
                &format!(
                    r#"{{"host": "{}", "pathPrefix": "/a/", "sshUser": "git"}}"#,
                    "a".repeat(254)
                ),
                "host",
            ),
            (r#"{"host": "github.com", "sshUser": "git"}"#, "pathPrefix"),
            (
                r#"{"host": "github.com", "pathPrefix": "a/", "sshUser": "git"}"#,
                "pathPrefix",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a", "sshUser": "git"}"#,
                "pathPrefix",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a%2F/", "sshUser": "git"}"#,
                "pathPrefix",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a/../b/", "sshUser": "git"}"#,
                "pathPrefix",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a b/", "sshUser": "git"}"#,
                "pathPrefix",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a\tb/", "sshUser": "git"}"#,
                "pathPrefix",
            ),
            (
                &format!(
                    r#"{{"host": "github.com", "pathPrefix": "/{}/", "sshUser": "git"}}"#,
                    "a".repeat(255)
                ),
                "pathPrefix",
            ),
            (r#"{"host": "github.com", "pathPrefix": "/a/"}"#, "sshUser"),
            (
                r#"{"host": "github.com", "pathPrefix": "/a/", "sshUser": "-oProxyCommand"}"#,
                "sshUser",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a/", "sshUser": "git@evil"}"#,
                "sshUser",
            ),
            (
                &format!(
                    r#"{{"host": "github.com", "pathPrefix": "/a/", "sshUser": "{}"}}"#,
                    "a".repeat(65)
                ),
                "sshUser",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a/", "sshUser": "git", "sshAgentSocket": "agent.sock"}"#,
                "sshAgentSocket",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a/", "sshUser": "git", "sshAgentSocket": 1}"#,
                "sshAgentSocket",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a/", "sshUser": "git", "rewriteHttps": "no"}"#,
                "rewriteHttps",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a/", "sshUser": "git", "platforms": "macos"}"#,
                "platforms",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a/", "sshUser": "git", "platforms": ["beos"]}"#,
                "platforms",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a/", "sshUser": "git", "platforms": []}"#,
                "platforms",
            ),
        ] {
            let file = parse(&format!(
                r#"{{"version": 1, "rules": [{invalid}, {valid}]}}"#
            ))
            .unwrap();
            assert_eq!(
                file.rules,
                vec![rule("github.com", "/ok/", "git")],
                "{invalid}"
            );
            assert_eq!(file.problems.len(), 1, "{invalid}");
            assert!(
                file.problems[0].starts_with("Rule 1: "),
                "{:?}",
                file.problems
            );
            assert!(
                file.problems[0].contains(field),
                "{field}: {:?}",
                file.problems
            );
        }
    }

    #[test]
    fn rejects_unusable_files_as_a_whole() {
        for (text, reason) in [
            ("[]", "Expected a JSON object"),
            ("{", "Invalid JSON"),
            (r#"{"rules": []}"#, "Missing version"),
            (r#"{"version": 2}"#, "Unsupported version"),
            (r#"{"version": 1, "rules": {}}"#, "rules must be an array"),
            (
                r#"{"version": 1, "builtInRules": "no"}"#,
                "builtInRules must be true or false",
            ),
        ] {
            let error = parse(text).err().unwrap_or_else(|| panic!("{text} parsed"));
            assert!(error.starts_with(reason), "{text}: {error}");
        }
    }

    #[test]
    fn caps_rules() {
        let rules =
            vec![r#"{"host": "github.com", "pathPrefix": "/a/", "sshUser": "git"}"#; MAX_RULES + 1];
        let file = parse(&format!(
            r#"{{"version": 1, "rules": [{}]}}"#,
            rules.join(",")
        ))
        .unwrap();
        assert_eq!(file.rules.len(), MAX_RULES);
        assert_eq!(
            file.problems,
            vec!["Only the first 32 of 33 rules are used"]
        );
        let invalid = vec!["[]"; MAX_RULES];
        assert_eq!(
            problems(&format!(
                r#"{{"version": 1, "rules": [{}]}}"#,
                invalid.join(",")
            ))
            .len(),
            MAX_PROBLEMS
        );
    }

    #[test]
    fn load_orders_file_rules_before_built_ins_and_falls_back_to_them() {
        let root = tempfile::tempdir().unwrap();
        let absent = load(root.path(), None);
        assert_eq!(absent.status, Status::Absent);
        assert_eq!(absent.path, Some(root.path().join(FILE_NAME)));
        assert_eq!(absent.rules, built_in_rules());

        let file = root.path().join(FILE_NAME);
        fs::write(&file, r#"{"version": 1, "rules": [{"host": "github.com", "pathPrefix": "/a/", "sshUser": "git"}, []]}"#).unwrap();
        let ready = load(root.path(), None);
        assert_eq!(ready.status, Status::Ready);
        let mut expected = vec![rule("github.com", "/a/", "git")];
        expected.extend(built_in_rules());
        assert_eq!(ready.rules, expected);
        assert_eq!(ready.problems.len(), 1);

        fs::write(
            &file,
            r#"{"version": 1, "builtInRules": false, "rules": []}"#,
        )
        .unwrap();
        assert!(load(root.path(), None).rules.is_empty());

        fs::write(&file, r#"{"version": 2}"#).unwrap();
        let invalid = load(root.path(), None);
        assert!(matches!(invalid.status, Status::Invalid { .. }));
        assert_eq!(invalid.rules, built_in_rules());

        fs::write(&file, vec![b' '; MAX_BYTES as usize + 1]).unwrap();
        assert_eq!(
            load(root.path(), None).status,
            Status::Invalid {
                reason: "Repository access file exceeds 64 KiB".into()
            }
        );
    }

    #[test]
    fn env_override_must_be_absolute() {
        let root = tempfile::tempdir().unwrap();
        let elsewhere = root.path().join("elsewhere.json");
        fs::write(&elsewhere, r#"{"version": 1, "builtInRules": false}"#).unwrap();
        let overridden = load(Path::new("/nonexistent"), Some(elsewhere.clone().into()));
        assert_eq!(overridden.path, Some(elsewhere));
        assert!(overridden.rules.is_empty());

        let relative = load(root.path(), Some("relative.json".into()));
        assert_eq!(
            relative.status,
            Status::Invalid {
                reason: format!("{PATH_ENV} must be an absolute path")
            }
        );
        assert_eq!(relative.rules, built_in_rules());
        assert_eq!(load(root.path(), Some("".into())).status, Status::Absent);
    }
}
