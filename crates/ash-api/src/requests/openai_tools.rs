use crate::ApiError;
use crate::ToolDefinition;
use serde_json::Value;

/// Checks the object constraints required by OpenAI strict function calling before transport.
pub(crate) fn validate_tools(tools: &[ToolDefinition]) -> Result<(), ApiError> {
    for tool in tools.iter().filter(|tool| tool.strict) {
        if tool.parameters.get("type").and_then(Value::as_str) != Some("object") {
            return Err(invalid(tool, "parameters", "root type must be object"));
        }
        validate_schema(tool, &tool.parameters, "parameters", 0)?;
    }
    Ok(())
}

fn validate_schema(
    tool: &ToolDefinition,
    schema: &Value,
    path: &str,
    depth: usize,
) -> Result<(), ApiError> {
    if depth > 32 {
        return Err(invalid(tool, path, "schema exceeds depth limit 32"));
    }
    if schema.get("oneOf").is_some() {
        return Err(invalid(tool, path, "oneOf is not supported"));
    }
    let object_type = match schema.get("type") {
        Some(Value::String(kind)) => kind == "object",
        Some(Value::Array(kinds)) => kinds.iter().any(|kind| kind.as_str() == Some("object")),
        _ => false,
    };
    if object_type || schema.get("properties").is_some() {
        if schema.get("additionalProperties") != Some(&Value::Bool(false)) {
            return Err(invalid(tool, path, "additionalProperties must be false"));
        }
        let properties = schema
            .get("properties")
            .and_then(Value::as_object)
            .ok_or_else(|| invalid(tool, path, "properties must be an object"))?;
        let required = schema
            .get("required")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid(tool, path, "required must list every property"))?;
        for name in properties.keys() {
            if !required.iter().any(|entry| entry.as_str() == Some(name)) {
                return Err(invalid(
                    tool,
                    path,
                    &format!("required is missing '{name}'"),
                ));
            }
        }
        if required.len() != properties.len() {
            return Err(invalid(
                tool,
                path,
                "required must list each property exactly once",
            ));
        }
    }

    // Visit schema-bearing keywords only; defaults, examples, and enum values are user data.
    for keyword in ["properties", "$defs", "definitions"] {
        if let Some(children) = schema.get(keyword).and_then(Value::as_object) {
            for (name, child) in children {
                validate_schema(tool, child, &format!("{path}.{keyword}.{name}"), depth + 1)?;
            }
        }
    }
    for keyword in ["items", "anyOf", "allOf", "prefixItems"] {
        if let Some(child) = schema.get(keyword) {
            let child_path = format!("{path}.{keyword}");
            if let Value::Array(children) = child {
                for (index, child) in children.iter().enumerate() {
                    validate_schema(tool, child, &format!("{child_path}[{index}]"), depth + 1)?;
                }
            } else {
                validate_schema(tool, child, &child_path, depth + 1)?;
            }
        }
    }
    Ok(())
}

fn invalid(tool: &ToolDefinition, path: &str, reason: &str) -> ApiError {
    ApiError::InvalidRequest(format!(
        "OpenAI strict tool '{}' at {path}: {reason}",
        tool.name
    ))
}
