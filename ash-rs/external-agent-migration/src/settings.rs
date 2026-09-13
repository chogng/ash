use std::path::Path;
use std::path::PathBuf;

use serde_json::Value;

use crate::AgentImportDiagnosticCode;
use crate::ImportItemKind;
use crate::source::Document;
use crate::source::MAX_DOCUMENT_DEPTH;
use crate::source::MAX_DOCUMENT_NODES;
use crate::source::Source;

pub(crate) struct ClaudeSettings {
    pub(crate) documents: Vec<Document<Value>>,
    pub(crate) effective: Value,
}

impl ClaudeSettings {
    pub(crate) fn paths(&self) -> Vec<PathBuf> {
        self.documents
            .iter()
            .map(|document| document.path.clone())
            .collect()
    }
}

/// Invalid files are diagnosed independently; only successfully parsed sources are merged.
pub(crate) fn claude_effective_settings(source: &mut Source) -> Option<ClaudeSettings> {
    let documents: Vec<_> = [".claude/settings.json", ".claude/settings.local.json"]
        .into_iter()
        .filter_map(|path| source.read(Path::new(path), ImportItemKind::Settings, parse_json))
        .collect();
    let mut effective = documents.first()?.value.clone();
    for document in documents.iter().skip(1) {
        merge_json_settings(&mut effective, &document.value);
    }
    Some(ClaudeSettings {
        documents,
        effective,
    })
}

pub(crate) fn parse_json(raw: &str) -> Result<Value, AgentImportDiagnosticCode> {
    let value: Value =
        serde_json::from_str(raw).map_err(|_| AgentImportDiagnosticCode::InvalidContent)?;
    let mut pending = vec![(&value, 0)];
    let mut nodes = 0;
    while let Some((value, depth)) = pending.pop() {
        nodes += 1;
        if depth > MAX_DOCUMENT_DEPTH || nodes > MAX_DOCUMENT_NODES {
            return Err(AgentImportDiagnosticCode::LimitExceeded);
        }
        match value {
            Value::Array(values) => pending.extend(values.iter().map(|value| (value, depth + 1))),
            Value::Object(values) => {
                pending.extend(values.values().map(|value| (value, depth + 1)))
            }
            _ => {}
        }
    }
    Ok(value)
}

pub(crate) fn parse_toml(raw: &str) -> Result<toml::Value, AgentImportDiagnosticCode> {
    let value: toml::Value =
        toml::from_str(raw).map_err(|_| AgentImportDiagnosticCode::InvalidContent)?;
    let mut pending = vec![(&value, 0)];
    let mut nodes = 0;
    while let Some((value, depth)) = pending.pop() {
        nodes += 1;
        if depth > MAX_DOCUMENT_DEPTH || nodes > MAX_DOCUMENT_NODES {
            return Err(AgentImportDiagnosticCode::LimitExceeded);
        }
        match value {
            toml::Value::Array(values) => {
                pending.extend(values.iter().map(|value| (value, depth + 1)))
            }
            toml::Value::Table(values) => {
                pending.extend(values.values().map(|value| (value, depth + 1)))
            }
            _ => {}
        }
    }
    Ok(value)
}

fn merge_json_settings(existing: &mut Value, incoming: &Value) {
    match (existing, incoming) {
        (Value::Object(existing), Value::Object(incoming)) => {
            for (key, incoming_value) in incoming {
                match existing.get_mut(key) {
                    Some(existing_value) => merge_json_settings(existing_value, incoming_value),
                    None => {
                        existing.insert(key.clone(), incoming_value.clone());
                    }
                }
            }
        }
        (existing, incoming) => *existing = incoming.clone(),
    }
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
