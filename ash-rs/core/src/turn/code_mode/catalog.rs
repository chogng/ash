use crate::CoreError;
use ash_code_mode_protocol::CodeModeToolKind;
use ash_code_mode_protocol::EnabledTool;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolName;
use std::collections::BTreeSet;

use super::broker::EXEC_TOOL_NAME;
use super::broker::WAIT_TOOL_NAME;

pub fn control_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: tool_name(EXEC_TOOL_NAME),
            description: "Execute JavaScript in the Code Mode runtime. Use text(), image(), store(), load(), notify(), and await tools.<name>(args). If the result is still running, wait with its cellId.".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "source": { "type": "string" },
                    "code": { "type": "string" },
                    "yieldTimeMs": { "type": "integer", "minimum": 0 },
                    "maxOutputTokens": { "type": "integer", "minimum": 1 }
                },
                "anyOf": [
                    { "required": ["source"] },
                    { "required": ["code"] }
                ],
                "additionalProperties": false
            }),
            strict: true,
        },
        ToolDefinition {
            name: tool_name(WAIT_TOOL_NAME),
            description: "Wait for a Code Mode cell. Set terminate to true to stop it.".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "cellId": { "type": "string" },
                    "yieldTimeMs": { "type": "integer", "minimum": 0 },
                    "maxOutputTokens": { "type": "integer", "minimum": 1 },
                    "terminate": { "type": "boolean" }
                },
                "required": ["cellId"],
                "additionalProperties": false
            }),
            strict: true,
        },
    ]
}

pub fn control_definition(name: &ToolName) -> Option<ToolDefinition> {
    control_definitions()
        .into_iter()
        .find(|definition| &definition.name == name)
}

fn tool_name(value: &str) -> ToolName {
    ToolName::new(value).expect("Code Mode control tool names are valid")
}

pub fn is_control_name(name: &ToolName) -> bool {
    matches!(name.as_str(), EXEC_TOOL_NAME | WAIT_TOOL_NAME)
}

#[derive(Debug)]
pub(super) struct ParsedExecSource {
    pub(super) source: String,
    pub(super) yield_time_ms: Option<u64>,
    pub(super) max_output_tokens: Option<u32>,
}

pub(super) fn parse_exec_source(source: &str) -> Result<ParsedExecSource, CoreError> {
    let (first_line, body) = match source.split_once('\n') {
        Some((first_line, body)) => (first_line, body),
        None => (source, ""),
    };
    let Some(config_text) = first_line.trim().strip_prefix("// @exec:") else {
        return Ok(ParsedExecSource {
            source: source.to_owned(),
            yield_time_ms: None,
            max_output_tokens: None,
        });
    };
    let config =
        serde_json::from_str::<serde_json::Value>(config_text.trim()).map_err(|error| {
            CoreError::InvalidInput(format!("invalid Code Mode @exec configuration: {error}"))
        })?;
    let object = config.as_object().ok_or_else(|| {
        CoreError::InvalidInput("Code Mode @exec configuration must be a JSON object".into())
    })?;
    for key in object.keys() {
        if !matches!(
            key.as_str(),
            "yieldTimeMs" | "yield_time_ms" | "maxOutputTokens" | "max_output_tokens"
        ) {
            return Err(CoreError::InvalidInput(format!(
                "unsupported Code Mode @exec option: {key}"
            )));
        }
    }
    let yield_time_ms = directive_u64(object, &["yieldTimeMs", "yield_time_ms"])?;
    let max_output_tokens = directive_u64(object, &["maxOutputTokens", "max_output_tokens"])?
        .map(|value| {
            let value = u32::try_from(value).map_err(|_| {
                CoreError::InvalidInput("Code Mode @exec maxOutputTokens is too large".into())
            })?;
            if value == 0 {
                return Err(CoreError::InvalidInput(
                    "Code Mode @exec maxOutputTokens must be greater than zero".into(),
                ));
            }
            Ok(value)
        })
        .transpose()?;
    if body.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "Code Mode @exec configuration must be followed by JavaScript source".into(),
        ));
    }
    Ok(ParsedExecSource {
        source: body.to_owned(),
        yield_time_ms,
        max_output_tokens,
    })
}

fn directive_u64(
    object: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Result<Option<u64>, CoreError> {
    let mut value = None;
    for key in keys {
        if let Some(candidate) = object.get(*key) {
            if value.is_some() {
                return Err(CoreError::InvalidInput(format!(
                    "Code Mode @exec options `{}` and `{}` are aliases; provide one",
                    keys[0], keys[1]
                )));
            }
            value = Some(candidate.as_u64().ok_or_else(|| {
                CoreError::InvalidInput(format!(
                    "Code Mode @exec option `{key}` must be an integer"
                ))
            })?);
        }
    }
    Ok(value)
}

pub fn normalize_code_name(name: &str) -> String {
    let mut normalized = String::with_capacity(name.len());
    for character in name.chars() {
        if character.is_ascii_alphanumeric() || character == '_' {
            normalized.push(character.to_ascii_lowercase());
        } else {
            normalized.push_str("__");
        }
    }
    normalized
}

pub fn projected_tools(definitions: &[ToolDefinition]) -> Result<Vec<EnabledTool>, CoreError> {
    let mut projected = definitions
        .iter()
        .map(|definition| EnabledTool {
            global_name: normalize_code_name(definition.name.as_str()),
            tool_name: definition.name.to_string(),
            description: format!(
                "{}\nCode mode: await tools.{}(<arguments>)",
                definition.description,
                normalize_code_name(definition.name.as_str())
            ),
            kind: CodeModeToolKind::Function,
            input_schema: definition.parameters.clone(),
        })
        .collect::<Vec<_>>();
    projected.sort_by(|left, right| left.global_name.cmp(&right.global_name));
    let mut names = BTreeSet::new();
    for tool in &projected {
        if is_reserved_projection_name(&tool.global_name) {
            return Err(CoreError::Policy(format!(
                "Code Mode cannot expose reserved JavaScript tool name: {}",
                tool.global_name
            )));
        }
        if !names.insert(tool.global_name.clone()) {
            return Err(CoreError::Policy(format!(
                "Code Mode tool name collision: {}",
                tool.global_name
            )));
        }
    }
    if projected
        .iter()
        .any(|tool| is_control_projection_name(&tool.global_name))
    {
        return Err(CoreError::Policy(
            "ordinary Tool projection conflicts with Code Mode control tool name".into(),
        ));
    }
    Ok(projected)
}

fn is_reserved_projection_name(name: &str) -> bool {
    matches!(name, "__proto__" | "prototype" | "constructor")
}

fn is_control_projection_name(name: &str) -> bool {
    matches!(name, EXEC_TOOL_NAME | WAIT_TOOL_NAME)
}

pub(super) fn required_string(
    arguments: &serde_json::Value,
    keys: &[&str],
    label: &str,
) -> Result<String, CoreError> {
    let object = arguments.as_object().ok_or_else(|| {
        CoreError::InvalidInput("Code Mode control arguments must be an object".into())
    })?;
    keys.iter()
        .find_map(|key| object.get(*key).and_then(serde_json::Value::as_str))
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            CoreError::InvalidInput(format!("Code Mode control argument `{label}` is required"))
        })
}

pub(super) fn optional_u64(
    arguments: &serde_json::Value,
    keys: &[&str],
) -> Result<Option<u64>, CoreError> {
    let Some(object) = arguments.as_object() else {
        return Err(CoreError::InvalidInput(
            "Code Mode control arguments must be an object".into(),
        ));
    };
    for key in keys {
        if let Some(value) = object.get(*key) {
            return value.as_u64().map(Some).ok_or_else(|| {
                CoreError::InvalidInput(format!(
                    "Code Mode control argument `{key}` must be an integer"
                ))
            });
        }
    }
    Ok(None)
}
