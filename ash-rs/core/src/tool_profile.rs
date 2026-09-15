use crate::CoreError;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolProfileSnapshot;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeSet;

pub(crate) const SELECTED_CODING_TOOL_PROFILE_ID: &str = "selected-coding";

pub(crate) const DEFAULT_CODING_TOOL_PROFILE_ID: &str = "coding";
pub(crate) const DEFAULT_CODING_TOOL_PROFILE_REVISION: &str = "coding-v1";

pub(crate) fn snapshot_tool_profile(
    definitions: &[ToolDefinition],
) -> Result<ToolProfileSnapshot, CoreError> {
    Ok(ToolProfileSnapshot {
        id: DEFAULT_CODING_TOOL_PROFILE_ID.into(),
        revision: DEFAULT_CODING_TOOL_PROFILE_REVISION.into(),
        definition_digest: tool_definition_digest(definitions)?,
        tool_names: definitions
            .iter()
            .map(|definition| definition.name.clone())
            .collect(),
        parallel_tool_calls: true,
    })
}

pub(crate) fn validate_tool_profile_snapshot(profile: &ToolProfileSnapshot) -> Result<(), String> {
    if profile.id.trim().is_empty() || profile.revision.trim().is_empty() {
        return Err("tool profile identity and revision must not be empty".into());
    }
    if !profile.definition_digest.starts_with("sha256:")
        || profile.definition_digest.len() != "sha256:".len() + 64
        || !profile.definition_digest["sha256:".len()..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("tool profile definition digest must be a canonical SHA-256 digest".into());
    }
    let unique = profile.tool_names.iter().collect::<BTreeSet<_>>();
    if unique.len() != profile.tool_names.len() {
        return Err("tool profile names must be unique".into());
    }
    Ok(())
}

pub(crate) fn validate_tool_profile_definitions(
    profile: &ToolProfileSnapshot,
    definitions: &[ToolDefinition],
) -> Result<(), CoreError> {
    validate_tool_profile_snapshot(profile).map_err(CoreError::Context)?;
    let names = definitions
        .iter()
        .map(|definition| definition.name.clone())
        .collect::<Vec<_>>();
    if names != profile.tool_names
        || tool_definition_digest(definitions)? != profile.definition_digest
    {
        return Err(CoreError::Context(format!(
            "frozen tool profile {}@{} no longer matches the current tool definitions",
            profile.id, profile.revision
        )));
    }
    Ok(())
}

fn tool_definition_digest(definitions: &[ToolDefinition]) -> Result<String, CoreError> {
    let mut value = serde_json::to_value(definitions).map_err(|error| {
        CoreError::Context(format!("failed to serialize tool profile: {error}"))
    })?;
    canonicalize_json(&mut value);
    let encoded = serde_json::to_vec(&value)
        .map_err(|error| CoreError::Context(format!("failed to encode tool profile: {error}")))?;
    Ok(format!("sha256:{:x}", Sha256::digest(encoded)))
}

fn canonicalize_json(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Array(values) => {
            for value in values {
                canonicalize_json(value);
            }
        }
        serde_json::Value::Object(object) => {
            let mut entries = std::mem::take(object).into_iter().collect::<Vec<_>>();
            for (_, value) in &mut entries {
                canonicalize_json(value);
            }
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            object.extend(entries);
        }
        serde_json::Value::Null
        | serde_json::Value::Bool(_)
        | serde_json::Value::Number(_)
        | serde_json::Value::String(_) => {}
    }
}

#[cfg(test)]
#[path = "tool_profile_tests.rs"]
mod tests;
