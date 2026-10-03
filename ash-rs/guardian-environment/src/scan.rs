use crate::EntryKind;
use crate::EnvironmentEntry;
use crate::EnvironmentError;
use crate::EnvironmentSource;
use crate::SourceKind;
use async_utils::CancellationToken;
use file_access::Authorization;
use file_access::Permission;
use sha2::Digest;
use sha2::Sha256;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;

const MAX_SOURCE_BYTES: u64 = 32 * 1024;
pub(crate) const PROJECT_FILES: &[&str] = &[
    "README.md",
    "CLAUDE.md",
    "AGENTS.md",
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "go.mod",
    "Makefile",
    "justfile",
    "compose.yaml",
    "docker-compose.yml",
    ".mcp.json",
    ".git/config",
    ".github/workflows/deploy.yml",
    ".github/workflows/deploy.yaml",
];

pub(crate) fn check(token: &CancellationToken) -> Result<(), EnvironmentError> {
    token.check().map_err(|_| EnvironmentError::Cancelled)
}

pub(crate) fn digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

/// Drop complete sensitive lines before either persistence or model invocation. The scanner
/// never reads credential files, .env files, command arguments from shell history, or Git hooks.
pub(crate) fn safe_text(text: &str) -> String {
    let mut private_key = false;
    text.lines()
        .filter(|line| {
            if line.contains("-----BEGIN") {
                private_key = true;
            }
            let blocked = private_key || secret_line(line);
            if line.contains("-----END") {
                private_key = false;
            }
            !blocked
        })
        .take(80)
        .map(|line| line.chars().take(300).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

fn secret_line(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "passwd",
        "authorization",
        "api_key",
        "apikey",
        "credential",
        "private_key",
        "sk-",
        "ghp_",
        "github_pat_",
        "eyj",
        "bearer ",
    ]
    .iter()
    .any(|word| lower.contains(word))
        || line.split_whitespace().any(|word| word.len() > 80)
        || (lower.contains("://") && (lower.contains('@') || lower.contains('?')))
}

/// Reads through the opened directory capability, so a symlink cannot escape the read grant.
pub(crate) fn source_text(
    auth: &Authorization,
    path: &str,
) -> Result<Option<String>, EnvironmentError> {
    auth.execute(auth.subject(), auth.dir(), Permission::ReadFiles, || {
        let dir = auth.dir().directory().handle();
        let file = match dir.open(path) {
            Ok(file) => file,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(EnvironmentError::Source(error.to_string())),
        };
        let metadata = file
            .metadata()
            .map_err(|error| EnvironmentError::Source(error.to_string()))?;
        if !metadata.is_file() || metadata.len() > MAX_SOURCE_BYTES {
            return Ok(None);
        }
        let mut text = String::new();
        file.take(MAX_SOURCE_BYTES + 1)
            .read_to_string(&mut text)
            .map_err(|error| EnvironmentError::Source(error.to_string()))?;
        if text.len() as u64 > MAX_SOURCE_BYTES {
            return Ok(None);
        }
        Ok(Some(text))
    })
    .map_err(|error| EnvironmentError::Source(error.to_string()))?
}

pub(crate) fn project_entries(
    auth: &Authorization,
    token: &CancellationToken,
) -> Result<Vec<EnvironmentEntry>, EnvironmentError> {
    let mut entries = Vec::new();
    for path in PROJECT_FILES {
        check(token)?;
        let Some(text) = source_text(auth, path)? else {
            continue;
        };
        let content = safe_text(&text)
            .lines()
            .scan(0usize, |bytes, line| {
                *bytes += line.len() + 1;
                (*bytes <= 4096).then_some(line)
            })
            .collect::<Vec<_>>()
            .join("\n");
        if content.trim().is_empty() {
            continue;
        }
        let revision = digest(text.as_bytes());
        let id = digest(format!("project:{path}:{revision}").as_bytes());
        entries.push(EnvironmentEntry {
            id: id.clone(),
            kind: EntryKind::Fact,
            title: (*path).into(),
            content,
            source: EnvironmentSource {
                id,
                kind: SourceKind::ProjectFile,
                label: (*path).into(),
                revision,
            },
            accepted: false,
            current: true,
        });
    }
    Ok(entries)
}

pub(crate) fn is_current(
    auth: &Authorization,
    source: &EnvironmentSource,
) -> Result<bool, EnvironmentError> {
    match source.kind {
        SourceKind::ProjectFile => {
            if !PROJECT_FILES.contains(&source.label.as_str()) {
                return Err(EnvironmentError::Invalid("unknown project source".into()));
            }
            match source_text(auth, &source.label) {
                Ok(text) => Ok(text.is_some_and(|text| digest(text.as_bytes()) == source.revision)),
                Err(EnvironmentError::Source(_)) => Ok(false),
                Err(error) => Err(error),
            }
        }
        // These entries explicitly describe a historical observation; they do not assert that
        // a host remains owned, a command remains safe, or its source is currently accessible.
        SourceKind::RecentCommand
        | SourceKind::ShellHistory
        | SourceKind::OtherRepository
        | SourceKind::Manual => Ok(true),
    }
}

pub(crate) fn observation(kind: SourceKind, label: String, text: String) -> EnvironmentEntry {
    let content = safe_text(&text)
        .lines()
        .scan(0usize, |bytes, line| {
            *bytes += line.len() + 1;
            (*bytes <= 4096).then_some(line)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let revision = digest(content.as_bytes());
    let id = digest(format!("{kind:?}:{label}:{revision}").as_bytes());
    EnvironmentEntry {
        id: id.clone(),
        kind: EntryKind::Fact,
        title: label.clone(),
        content,
        source: EnvironmentSource {
            id,
            kind,
            label,
            revision,
        },
        accepted: false,
        current: true,
    }
}

/// Optional home inspection is a separate, explicitly selected directory authorization. Only
/// executable names and credential-free remote lines are returned, never history arguments.
pub fn home_observations(
    auth: &Authorization,
    options: &crate::ScanOptions,
    token: &CancellationToken,
) -> Result<Vec<EnvironmentEntry>, EnvironmentError> {
    let mut entries = Vec::new();
    if options.shell_history {
        for path in [".zsh_history", ".bash_history"] {
            check(token)?;
            if let Some(text) = history_tail(auth, path)? {
                let names = text
                    .lines()
                    .rev()
                    .take(200)
                    .filter_map(|line| {
                        let command = if line.starts_with(": ") {
                            line.split_once(';')?.1
                        } else {
                            line
                        };
                        let name = command.split_whitespace().next()?;
                        (name.len() < 64
                            && name
                                .chars()
                                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')))
                        .then_some(name)
                    })
                    .collect::<std::collections::BTreeSet<_>>()
                    .into_iter()
                    .collect::<Vec<_>>()
                    .join(", ");
                entries.push(observation(
                    SourceKind::ShellHistory,
                    format!("Historical command names ({path})"),
                    names,
                ));
            }
        }
    }
    if options.other_repositories {
        let children = auth
            .execute(auth.subject(), auth.dir(), Permission::ReadFiles, || {
                auth.dir().directory().handle().entries().map(|entries| {
                    entries
                        .filter_map(Result::ok)
                        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                        .filter_map(|entry| entry.file_name().into_string().ok())
                        .take(100)
                        .collect::<Vec<_>>()
                })
            })
            .map_err(|error| EnvironmentError::Source(error.to_string()))?
            .map_err(|error| EnvironmentError::Source(error.to_string()))?;
        for name in children {
            check(token)?;
            let path = format!("{name}/.git/config");
            if let Some(text) = source_text(auth, &path)? {
                let remotes = safe_text(&text)
                    .lines()
                    .filter(|line| line.trim().starts_with("url ="))
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
                    .join("\n");
                if !remotes.is_empty() {
                    entries.push(observation(
                        SourceKind::OtherRepository,
                        format!("Historical Git remotes: {name}"),
                        remotes,
                    ));
                }
            }
            if entries.len() >= 32 {
                break;
            }
        }
    }
    Ok(entries)
}

fn history_tail(auth: &Authorization, path: &str) -> Result<Option<String>, EnvironmentError> {
    auth.execute(auth.subject(), auth.dir(), Permission::ReadFiles, || {
        let mut file = match auth.dir().directory().handle().open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(EnvironmentError::Source(error.to_string())),
        };
        let metadata = file
            .metadata()
            .map_err(|error| EnvironmentError::Source(error.to_string()))?;
        if !metadata.is_file() {
            return Ok(None);
        }
        let offset = metadata.len().saturating_sub(MAX_SOURCE_BYTES);
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| EnvironmentError::Source(error.to_string()))?;
        let mut bytes = Vec::new();
        file.take(MAX_SOURCE_BYTES)
            .read_to_end(&mut bytes)
            .map_err(|error| EnvironmentError::Source(error.to_string()))?;
        let text = String::from_utf8_lossy(&bytes);
        let text = if offset > 0 {
            text.split_once('\n').map_or("", |(_, tail)| tail)
        } else {
            &text
        };
        Ok(Some(text.to_owned()))
    })
    .map_err(|error| EnvironmentError::Source(error.to_string()))?
}
