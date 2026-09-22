use crate::AgentRole;
use crate::AgentRoleDiagnostic;
use crate::AgentRoleDiagnosticCode;
use crate::AgentRoleSource;
use crate::RoleLaunch;
use crate::model::AgentRoleFields;
use serde::Deserialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeSet;
use std::path::Path;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Frontmatter {
    name: String,
    description: String,
    version: Option<u64>,
    #[serde(default)]
    launch: RoleLaunch,
    #[serde(default)]
    callers: Vec<String>,
    delegates: Option<Vec<String>>,
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

/// Parses both packaged and directory definitions, with source authority supplied by the loader.
pub(crate) fn parse(
    source: &AgentRoleSource,
    path: &Path,
    text: &str,
) -> Result<AgentRole, AgentRoleDiagnostic> {
    let error =
        |code, message: &str| AgentRoleDiagnostic::new(Some(path.to_path_buf()), code, message);
    let normalized = text.replace("\r\n", "\n");
    let (frontmatter, body) = normalized
        .strip_prefix("---\n")
        .and_then(|rest| rest.split_once("\n---\n"))
        .ok_or_else(|| {
            error(
                AgentRoleDiagnosticCode::InvalidFrontmatter,
                "Agent definition must start with YAML frontmatter",
            )
        })?;
    let data: Frontmatter = serde_yaml::from_str(frontmatter).map_err(|_| {
        error(
            AgentRoleDiagnosticCode::InvalidFrontmatter,
            "Agent definition frontmatter is invalid",
        )
    })?;
    if !valid_name(&data.name)
        || path.file_stem().and_then(|stem| stem.to_str()) != Some(&data.name)
    {
        return Err(error(
            AgentRoleDiagnosticCode::InvalidName,
            "Agent name must match its lowercase filename",
        ));
    }
    let name = match source {
        AgentRoleSource::BuiltIn => {
            if !data.version.is_some_and(|version| version > 0) {
                return Err(error(
                    AgentRoleDiagnosticCode::InvalidFrontmatter,
                    "Packaged roles require a positive version",
                ));
            }
            let name = path.with_extension("").to_string_lossy().replace('\\', "/");
            if !name.split('/').all(valid_name) {
                return Err(error(
                    AgentRoleDiagnosticCode::InvalidName,
                    "Packaged role paths must contain lowercase role names",
                ));
            }
            name
        }
        AgentRoleSource::Directory { .. } => {
            if data.version.is_some()
                || data.launch != RoleLaunch::Any
                || !data.callers.is_empty()
                || data.delegates.is_some()
            {
                return Err(error(
                    AgentRoleDiagnosticCode::InvalidFrontmatter,
                    "Version and product launch restrictions belong to packaged roles",
                ));
            }
            data.name
        }
    };
    let description = data.description.trim();
    if description.is_empty() || description.len() > 1024 {
        return Err(error(
            AgentRoleDiagnosticCode::DescriptionInvalid,
            "Agent description must contain 1 to 1024 UTF-8 bytes",
        ));
    }
    if data
        .model
        .as_deref()
        .is_some_and(|value| !valid_reference(value))
        || [
            data.tools.as_deref(),
            data.delegation_tools.as_deref(),
            data.skills.as_deref(),
            data.delegates.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|values| !valid_references(values))
        || [
            &data.disallowed_tools,
            &data.required_tools,
            &data.disallowed_delegation_tools,
            &data.required_delegation_tools,
            &data.required_skills,
            &data.instructions,
            &data.callers,
        ]
        .into_iter()
        .any(|values| !valid_references(values))
    {
        return Err(error(
            AgentRoleDiagnosticCode::InvalidReference,
            "Agent model, tool, Skill, Instruction and role references must be valid and unique",
        ));
    }
    if !available(
        &data.required_tools,
        data.tools.as_deref(),
        &data.disallowed_tools,
    ) || !available(
        &data.required_delegation_tools,
        data.delegation_tools.as_deref(),
        &data.disallowed_delegation_tools,
    ) || !available(&data.required_skills, data.skills.as_deref(), &[])
    {
        return Err(error(
            AgentRoleDiagnosticCode::InvalidReference,
            "Agent required Tool and Skill references must remain available after role filtering",
        ));
    }
    let body = body.trim();
    if body.is_empty() {
        return Err(error(
            AgentRoleDiagnosticCode::EmptyBody,
            "Agent role instructions cannot be empty",
        ));
    }
    Ok(AgentRole::new(AgentRoleFields {
        name,
        description: description.to_owned(),
        source: source.clone(),
        version: data.version,
        content_digest: format!("sha256:{:x}", Sha256::digest(normalized.as_bytes())),
        relative_path: path.to_path_buf(),
        launch: data.launch,
        callers: data.callers,
        delegates: data.delegates,
        model: data.model,
        tools: data.tools,
        disallowed_tools: data.disallowed_tools,
        required_tools: data.required_tools,
        delegation_tools: data.delegation_tools,
        disallowed_delegation_tools: data.disallowed_delegation_tools,
        required_delegation_tools: data.required_delegation_tools,
        skills: data.skills,
        required_skills: data.required_skills,
        instructions: data.instructions,
        role_instructions: body.to_owned(),
    }))
}

fn available(required: &[String], allowed: Option<&[String]>, denied: &[String]) -> bool {
    required
        .iter()
        .all(|item| !denied.contains(item) && allowed.is_none_or(|values| values.contains(item)))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && !name.ends_with('-')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_reference(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
}

fn valid_references(values: &[String]) -> bool {
    values.iter().all(|value| valid_reference(value))
        && values.iter().collect::<BTreeSet<_>>().len() == values.len()
}
