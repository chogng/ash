use crate::model::AgentRole;
use crate::model::AgentRoleCatalogSnapshot;
use crate::model::AgentRoleDiagnostic;
use crate::model::AgentRoleDiagnosticCode;
use crate::model::AgentRoleFields;
use crate::model::AgentRoleSource;
use serde::Deserialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeSet;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

const AGENT_DIRECTORY: &str = ".ash/agents";
const MAX_ENTRIES: usize = 64;
const MAX_FILE_BYTES: usize = 32 * 1024;
const MAX_DESCRIPTION_BYTES: usize = 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AgentFrontmatter {
    name: String,
    description: String,
    model: Option<String>,
    tools: Option<Vec<String>>,
    #[serde(default)]
    disallowed_tools: Vec<String>,
    #[serde(default)]
    required_tools: Vec<String>,
    delegation_tools: Option<Vec<String>>,
    #[serde(default)]
    disallowed_delegation_tools: Vec<String>,
    #[serde(default)]
    required_delegation_tools: Vec<String>,
    skills: Option<Vec<String>>,
    #[serde(default)]
    required_skills: Vec<String>,
    #[serde(default)]
    instructions: Vec<String>,
}

/// Refreshable catalog for one directory's native Agent definition directory.
pub struct AgentRoleCatalog {
    source: AgentRoleSource,
    dir_root: PathBuf,
    snapshot: Arc<AgentRoleCatalogSnapshot>,
}

impl AgentRoleCatalog {
    pub fn discover(source_id: impl Into<String>, dir_root: impl AsRef<Path>) -> Self {
        let source = AgentRoleSource::Directory {
            id: source_id.into(),
        };
        let dir_root = dir_root.as_ref().to_path_buf();
        let (entries, diagnostics) = scan(&source, &dir_root);
        Self {
            source,
            dir_root,
            snapshot: Arc::new(AgentRoleCatalogSnapshot::new(1, entries, diagnostics)),
        }
    }

    pub fn snapshot(&self) -> Arc<AgentRoleCatalogSnapshot> {
        Arc::clone(&self.snapshot)
    }

    pub fn refresh(&mut self) -> Arc<AgentRoleCatalogSnapshot> {
        let (entries, diagnostics) = scan(&self.source, &self.dir_root);
        if self.snapshot.entries() == entries && self.snapshot.diagnostics() == diagnostics {
            return Arc::clone(&self.snapshot);
        }
        self.snapshot = Arc::new(AgentRoleCatalogSnapshot::new(
            self.snapshot
                .generation()
                .checked_add(1)
                .expect("Agent definition catalog generation overflowed"),
            entries,
            diagnostics,
        ));
        Arc::clone(&self.snapshot)
    }
}

fn scan(source: &AgentRoleSource, dir_root: &Path) -> (Vec<AgentRole>, Vec<AgentRoleDiagnostic>) {
    let source_root = dir_root.join(AGENT_DIRECTORY);
    let metadata = match fs::symlink_metadata(&source_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return (Vec::new(), Vec::new()),
        Err(_) => {
            return (
                Vec::new(),
                vec![diagnostic(
                    None,
                    AgentRoleDiagnosticCode::SourceUnavailable,
                    "Directory Agent definition directory metadata is unavailable",
                )],
            );
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return (
            Vec::new(),
            vec![diagnostic(
                None,
                AgentRoleDiagnosticCode::SourceUnavailable,
                "Directory Agent definition path must be a real directory",
            )],
        );
    }
    let mut paths = match fs::read_dir(&source_root) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect::<Vec<_>>(),
        Err(_) => {
            return (
                Vec::new(),
                vec![diagnostic(
                    None,
                    AgentRoleDiagnosticCode::SourceUnavailable,
                    "Directory Agent definition directory cannot be read",
                )],
            );
        }
    };
    paths.sort();
    let mut diagnostics = Vec::new();
    if paths.len() > MAX_ENTRIES {
        diagnostics.push(diagnostic(
            None,
            AgentRoleDiagnosticCode::EntryLimitExceeded,
            format!("only the first {MAX_ENTRIES} Agent definitions are inspected"),
        ));
        paths.truncate(MAX_ENTRIES);
    }
    let mut entries = paths
        .into_iter()
        .filter_map(|path| load_entry(source, &source_root, &path, &mut diagnostics))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.name().cmp(right.name()));
    diagnostics.sort_by(|left, right| {
        (left.relative_path(), left.code(), left.message()).cmp(&(
            right.relative_path(),
            right.code(),
            right.message(),
        ))
    });
    (entries, diagnostics)
}

fn load_entry(
    source: &AgentRoleSource,
    source_root: &Path,
    path: &Path,
    diagnostics: &mut Vec<AgentRoleDiagnostic>,
) -> Option<AgentRole> {
    let relative_path = path.strip_prefix(source_root).ok()?.to_path_buf();
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => {
            diagnostics.push(diagnostic(
                Some(relative_path),
                AgentRoleDiagnosticCode::SourceUnavailable,
                "Agent definition metadata is unavailable",
            ));
            return None;
        }
    };
    if metadata.file_type().is_symlink() {
        diagnostics.push(diagnostic(
            Some(relative_path),
            AgentRoleDiagnosticCode::SymlinkNotAllowed,
            "Agent definitions cannot be symbolic links",
        ));
        return None;
    }
    if !metadata.is_file() || path.extension().and_then(|value| value.to_str()) != Some("md") {
        diagnostics.push(diagnostic(
            Some(relative_path),
            AgentRoleDiagnosticCode::UnsupportedFileType,
            "Agent definitions must be direct .md files",
        ));
        return None;
    }
    if metadata.len() > MAX_FILE_BYTES as u64 {
        diagnostics.push(diagnostic(
            Some(relative_path),
            AgentRoleDiagnosticCode::ContentTooLarge,
            format!("Agent definition exceeds {MAX_FILE_BYTES} bytes"),
        ));
        return None;
    }
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => {
            diagnostics.push(diagnostic(
                Some(relative_path),
                AgentRoleDiagnosticCode::SourceUnavailable,
                "Agent definition content cannot be read",
            ));
            return None;
        }
    };
    let content_digest = format!("sha256:{:x}", Sha256::digest(&bytes));
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => {
            diagnostics.push(diagnostic(
                Some(relative_path),
                AgentRoleDiagnosticCode::ContentInvalidUtf8,
                "Agent definition content must be UTF-8",
            ));
            return None;
        }
    };
    let (frontmatter, body) = match split_frontmatter(&text) {
        Some(parts) => parts,
        None => {
            diagnostics.push(diagnostic(
                Some(relative_path),
                AgentRoleDiagnosticCode::InvalidFrontmatter,
                "Agent definition must start with YAML frontmatter",
            ));
            return None;
        }
    };
    let frontmatter: AgentFrontmatter = match serde_yaml::from_str(frontmatter) {
        Ok(frontmatter) => frontmatter,
        Err(_) => {
            diagnostics.push(diagnostic(
                Some(relative_path),
                AgentRoleDiagnosticCode::InvalidFrontmatter,
                "Agent definition frontmatter is invalid",
            ));
            return None;
        }
    };
    let file_name = path.file_stem()?.to_str()?;
    if !valid_name(&frontmatter.name) || frontmatter.name != file_name {
        diagnostics.push(diagnostic(
            Some(relative_path),
            AgentRoleDiagnosticCode::InvalidName,
            "Agent name must match its lowercase filename",
        ));
        return None;
    }
    let description = frontmatter.description.trim().to_owned();
    if description.is_empty() || description.len() > MAX_DESCRIPTION_BYTES {
        diagnostics.push(diagnostic(
            Some(relative_path),
            AgentRoleDiagnosticCode::DescriptionInvalid,
            "Agent description must contain 1 to 1024 UTF-8 bytes",
        ));
        return None;
    }
    let model = match frontmatter.model {
        Some(model) if valid_reference(&model) => Some(model),
        Some(_) => {
            diagnostics.push(diagnostic(
                Some(relative_path),
                AgentRoleDiagnosticCode::InvalidReference,
                "Agent model reference is invalid",
            ));
            return None;
        }
        None => None,
    };
    let tools = validate_optional_references(frontmatter.tools);
    let disallowed_tools = validate_references(frontmatter.disallowed_tools);
    let required_tools = validate_references(frontmatter.required_tools);
    let delegation_tools = validate_optional_references(frontmatter.delegation_tools);
    let disallowed_delegation_tools = validate_references(frontmatter.disallowed_delegation_tools);
    let required_delegation_tools = validate_references(frontmatter.required_delegation_tools);
    let skills = validate_optional_references(frontmatter.skills);
    let required_skills = validate_references(frontmatter.required_skills);
    let instructions = validate_references(frontmatter.instructions);
    let (
        tools,
        disallowed_tools,
        required_tools,
        delegation_tools,
        disallowed_delegation_tools,
        required_delegation_tools,
        skills,
        required_skills,
        instructions,
    ) = match (
        tools,
        disallowed_tools,
        required_tools,
        delegation_tools,
        disallowed_delegation_tools,
        required_delegation_tools,
        skills,
        required_skills,
        instructions,
    ) {
        (
            Some(tools),
            Some(disallowed_tools),
            Some(required_tools),
            Some(delegation_tools),
            Some(disallowed_delegation_tools),
            Some(required_delegation_tools),
            Some(skills),
            Some(required_skills),
            Some(instructions),
        ) => (
            tools,
            disallowed_tools,
            required_tools,
            delegation_tools,
            disallowed_delegation_tools,
            required_delegation_tools,
            skills,
            required_skills,
            instructions,
        ),
        _ => {
            diagnostics.push(diagnostic(
                Some(relative_path),
                AgentRoleDiagnosticCode::InvalidReference,
                "Agent tool, Skill, and Instruction references must be valid and unique",
            ));
            return None;
        }
    };
    if required_tools
        .iter()
        .any(|required| disallowed_tools.contains(required))
        || tools.as_ref().is_some_and(|tools| {
            required_tools
                .iter()
                .any(|required| !tools.contains(required))
        })
        || required_delegation_tools
            .iter()
            .any(|required| disallowed_delegation_tools.contains(required))
        || delegation_tools.as_ref().is_some_and(|tools| {
            required_delegation_tools
                .iter()
                .any(|required| !tools.contains(required))
        })
        || skills.as_ref().is_some_and(|skills| {
            required_skills
                .iter()
                .any(|required| !skills.contains(required))
        })
    {
        diagnostics.push(diagnostic(
            Some(relative_path),
            AgentRoleDiagnosticCode::InvalidReference,
            "Agent required Tool and Skill references must remain available after role filtering",
        ));
        return None;
    }
    let role_instructions = body.trim().to_owned();
    if role_instructions.is_empty() {
        diagnostics.push(diagnostic(
            Some(relative_path),
            AgentRoleDiagnosticCode::EmptyBody,
            "Agent role instructions cannot be empty",
        ));
        return None;
    }
    Some(AgentRole::new(AgentRoleFields {
        launch: crate::RoleLaunch::Any,
        callers: Vec::new(),
        delegates: None,
        name: frontmatter.name,
        description,
        source: source.clone(),
        version: None,
        content_digest,
        relative_path,
        model,
        tools,
        disallowed_tools,
        required_tools,
        delegation_tools,
        disallowed_delegation_tools,
        required_delegation_tools,
        skills,
        required_skills,
        instructions,
        role_instructions,
    }))
}

fn validate_references(values: Vec<String>) -> Option<Vec<String>> {
    if values.iter().any(|value| !valid_reference(value)) {
        return None;
    }
    let unique = values.iter().collect::<BTreeSet<_>>();
    (unique.len() == values.len()).then_some(values)
}

fn validate_optional_references(values: Option<Vec<String>>) -> Option<Option<Vec<String>>> {
    match values {
        Some(values) => validate_references(values).map(Some),
        None => Some(None),
    }
}

pub(super) fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && !name.ends_with('-')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

pub(super) fn valid_reference(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
}

fn split_frontmatter(text: &str) -> Option<(&str, &str)> {
    let rest = text.strip_prefix("---\n")?;
    let boundary = rest.find("\n---\n")?;
    Some((&rest[..boundary], &rest[boundary + 5..]))
}

fn diagnostic(
    relative_path: Option<PathBuf>,
    code: AgentRoleDiagnosticCode,
    message: impl Into<String>,
) -> AgentRoleDiagnostic {
    AgentRoleDiagnostic::new(relative_path, code, message)
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
