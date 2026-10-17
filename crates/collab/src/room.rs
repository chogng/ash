use crate::DocumentCollaborationSnapshot;
use crate::DocumentCollaborationSubmitResult;
use crate::DocumentCollaborationUpdate;
use getrandom::getrandom;
use serde_json::Value;

pub(crate) const MAX_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_TRANSACTION_BYTES: usize = 1_048_576;
pub(crate) const MAX_ROOM_HISTORY: usize = 512;
pub(crate) const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Recoverable ordered history returned by a durable collaboration authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DocumentCollaborationReplay {
    Updates(Vec<DocumentCollaborationUpdate>),
    Resync(DocumentCollaborationSnapshot),
}

pub(crate) fn validate_identifier(value: &str, name: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 {
        return Err(format!("{name} must contain between 1 and 128 characters"));
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!(
            "{name} may contain only letters, numbers, '-' and '_'"
        ));
    }
    Ok(())
}

pub(crate) fn validate_javascript_safe_integer(
    value: u64,
    name: &str,
    minimum: u64,
) -> Result<(), String> {
    if value < minimum || value > MAX_JAVASCRIPT_SAFE_INTEGER {
        return Err(format!(
            "{name} must be between {minimum} and {MAX_JAVASCRIPT_SAFE_INTEGER}"
        ));
    }
    Ok(())
}

pub(crate) fn validate_document(value: &str) -> Result<(), String> {
    let document = parse_json_object(value, MAX_DOCUMENT_BYTES, "document")?;
    if document.get("format") != Some(&Value::String("ash.document".into()))
        || document.get("version") != Some(&Value::Number(1.into()))
    {
        return Err("document must use the ash.document v1 envelope".into());
    }
    validate_document_node(document.get("document"), 0, &mut 0)
}

pub(crate) fn validate_transaction(value: &str) -> Result<(), String> {
    let transaction = parse_json_object(value, MAX_TRANSACTION_BYTES, "transaction")?;
    if transaction.get("format") != Some(&Value::String("ash.document.transaction".into()))
        || transaction.get("version") != Some(&Value::Number(1.into()))
    {
        return Err("transaction must use the ash.document.transaction v1 envelope".into());
    }
    let Some(body) = transaction.get("transaction").and_then(Value::as_object) else {
        return Err("transaction must contain a transaction object".into());
    };
    if !body.get("steps").is_some_and(Value::is_array)
        || !body.get("addToHistory").is_some_and(Value::is_boolean)
        || !body.get("selectionSet").is_some_and(Value::is_boolean)
        || !body.get("storedMarksSet").is_some_and(Value::is_boolean)
        || !body.get("metadata").is_some_and(Value::is_array)
    {
        return Err(
            "transaction must contain the required Document Engine transaction fields".into(),
        );
    }
    let steps = body
        .get("steps")
        .and_then(Value::as_array)
        .expect("checked above");
    if steps.len() > 10_000 {
        return Err("transaction cannot contain more than 10000 steps".into());
    }
    for step in steps {
        validate_transaction_step(step)?;
    }
    if let Some(selection) = body.get("selection") {
        validate_selection(selection)?;
    }
    if let Some(marks) = body.get("storedMarks") {
        validate_marks(marks)?;
    }
    Ok(())
}

pub(crate) fn validate_presence_selection(value: &str) -> Result<(), String> {
    let selection = parse_json_object(value, 64 * 1024, "presence selection")?;
    validate_selection(&Value::Object(selection))
}

pub(crate) fn snapshot(
    room_id: &str,
    version: u64,
    document: String,
) -> DocumentCollaborationSnapshot {
    DocumentCollaborationSnapshot {
        room_id: room_id.into(),
        version,
        document,
    }
}

pub(crate) fn replay(
    room_id: &str,
    version: u64,
    document: String,
    updates: Vec<DocumentCollaborationUpdate>,
    base_version: u64,
) -> DocumentCollaborationReplay {
    let history_start = updates
        .first()
        .map(|update| update.base_version)
        .unwrap_or(version);
    if base_version < history_start {
        return DocumentCollaborationReplay::Resync(snapshot(room_id, version, document));
    }
    DocumentCollaborationReplay::Updates(
        updates
            .into_iter()
            .filter(|update| update.version > base_version)
            .collect(),
    )
}

pub(crate) fn replay_submit_result(
    replay: DocumentCollaborationReplay,
) -> DocumentCollaborationSubmitResult {
    match replay {
        DocumentCollaborationReplay::Updates(updates) => {
            DocumentCollaborationSubmitResult::Conflict { updates }
        }
        DocumentCollaborationReplay::Resync(snapshot) => {
            DocumentCollaborationSubmitResult::Resync { snapshot }
        }
    }
}

pub(crate) fn random_room_id() -> Result<String, String> {
    random_identifier("document-", 16)
}

pub(crate) fn random_access_token() -> Result<String, String> {
    random_identifier("document-access-", 32)
}

pub(crate) fn random_principal_id() -> Result<String, String> {
    random_identifier("document-member-", 16)
}

fn random_identifier(prefix: &str, bytes: usize) -> Result<String, String> {
    let mut random = vec![0_u8; bytes];
    getrandom(&mut random)
        .map_err(|error| format!("Could not create a collaboration room ID: {error}"))?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut room_id = String::from(prefix);
    for byte in random {
        room_id.push(HEX[(byte >> 4) as usize] as char);
        room_id.push(HEX[(byte & 0x0f) as usize] as char);
    }
    Ok(room_id)
}

fn parse_json_object(
    value: &str,
    maximum_bytes: usize,
    name: &str,
) -> Result<serde_json::Map<String, Value>, String> {
    if value.is_empty() || value.len() > maximum_bytes {
        return Err(format!(
            "{name} must contain between 1 and {maximum_bytes} bytes"
        ));
    }
    let json: Value =
        serde_json::from_str(value).map_err(|_| format!("{name} must contain valid JSON"))?;
    json.as_object()
        .cloned()
        .ok_or_else(|| format!("{name} must contain a JSON object"))
}

fn validate_document_node(
    value: Option<&Value>,
    depth: usize,
    nodes: &mut usize,
) -> Result<(), String> {
    if depth > 128 {
        return Err("document cannot be nested deeper than 128 nodes".into());
    }
    *nodes += 1;
    if *nodes > 100_000 {
        return Err("document cannot contain more than 100000 nodes".into());
    }
    let Some(node) = value.and_then(Value::as_object) else {
        return Err("document nodes must be objects".into());
    };
    validate_non_empty_string(node.get("id"), "document node id")?;
    validate_non_empty_string(node.get("type"), "document node type")?;
    validate_attributes(node.get("attrs"), "document node attributes")?;
    validate_marks(node.get("marks").unwrap_or(&Value::Array(Vec::new())))?;
    if let Some(text) = node.get("text") {
        if !text.is_string() {
            return Err("document node text must be a string".into());
        }
    }
    let Some(content) = node.get("content").and_then(Value::as_array) else {
        return Err("document node content must be an array".into());
    };
    for child in content {
        validate_document_node(Some(child), depth + 1, nodes)?;
    }
    Ok(())
}

fn validate_transaction_step(value: &Value) -> Result<(), String> {
    let Some(step) = value.as_object() else {
        return Err("transaction steps must be objects".into());
    };
    let Some(kind) = step.get("kind").and_then(Value::as_str) else {
        return Err("transaction steps must contain a kind".into());
    };
    match kind {
        "replaceText" => {
            validate_non_empty_string(step.get("nodeId"), "replaceText nodeId")?;
            validate_safe_integer(step.get("from"), "replaceText from")?;
            validate_safe_integer(step.get("to"), "replaceText to")?;
            if !step.get("text").is_some_and(Value::is_string) {
                return Err("replaceText text must be a string".into());
            }
            if let Some(marks) = step.get("marks") {
                validate_marks(marks)?;
            }
        }
        "insertNode" => {
            validate_non_empty_string(step.get("parentId"), "insertNode parentId")?;
            validate_safe_integer(step.get("index"), "insertNode index")?;
            validate_document_node(step.get("node"), 0, &mut 0)?;
        }
        "deleteNode" => validate_non_empty_string(step.get("nodeId"), "deleteNode nodeId")?,
        "moveNode" => {
            validate_non_empty_string(step.get("nodeId"), "moveNode nodeId")?;
            validate_non_empty_string(step.get("parentId"), "moveNode parentId")?;
            validate_safe_integer(step.get("index"), "moveNode index")?;
        }
        "setNodeAttributes" => {
            validate_non_empty_string(step.get("nodeId"), "setNodeAttributes nodeId")?;
            validate_attributes(step.get("attrs"), "setNodeAttributes attrs")?;
        }
        "setNodeMarks" => {
            validate_non_empty_string(step.get("nodeId"), "setNodeMarks nodeId")?;
            validate_marks(step.get("marks").unwrap_or(&Value::Null))?;
        }
        "setNodeType" => {
            validate_non_empty_string(step.get("nodeId"), "setNodeType nodeId")?;
            validate_non_empty_string(step.get("type"), "setNodeType type")?;
            validate_attributes(step.get("attrs"), "setNodeType attrs")?;
        }
        _ => return Err("transaction contains an unknown Document Engine step kind".into()),
    }
    Ok(())
}

fn validate_selection(value: &Value) -> Result<(), String> {
    let Some(selection) = value.as_object() else {
        return Err("transaction selection must be an object".into());
    };
    match selection.get("kind").and_then(Value::as_str) {
        Some("all") => Ok(()),
        Some("node") => validate_non_empty_string(selection.get("nodeId"), "node selection nodeId"),
        Some("text") => {
            validate_point(selection.get("anchor"), "text selection anchor")?;
            validate_point(selection.get("head"), "text selection head")
        }
        _ => Err("transaction selection has an unknown kind".into()),
    }
}

fn validate_point(value: Option<&Value>, name: &str) -> Result<(), String> {
    let Some(point) = value.and_then(Value::as_object) else {
        return Err(format!("{name} must be an object"));
    };
    validate_non_empty_string(point.get("nodeId"), &format!("{name} nodeId"))?;
    validate_safe_integer(point.get("offset"), &format!("{name} offset"))
}

fn validate_marks(value: &Value) -> Result<(), String> {
    let Some(marks) = value.as_array() else {
        return Err("document marks must be an array".into());
    };
    for mark in marks {
        let Some(mark) = mark.as_object() else {
            return Err("document marks must contain objects".into());
        };
        validate_non_empty_string(mark.get("type"), "document mark type")?;
        validate_attributes(mark.get("attrs"), "document mark attrs")?;
    }
    Ok(())
}

fn validate_attributes(value: Option<&Value>, name: &str) -> Result<(), String> {
    let Some(attributes) = value.and_then(Value::as_object) else {
        return Err(format!("{name} must be an object"));
    };
    for (key, value) in attributes {
        if key.is_empty()
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(format!("{name} contains an invalid key"));
        }
        if !(value.is_null()
            || value.is_string()
            || value.is_boolean()
            || value.as_f64().is_some_and(f64::is_finite))
        {
            return Err(format!("{name} contains a non-JSON attribute value"));
        }
    }
    Ok(())
}

fn validate_non_empty_string(value: Option<&Value>, name: &str) -> Result<(), String> {
    if !value.is_some_and(|value| {
        value
            .as_str()
            .is_some_and(|value| !value.is_empty() && value.len() <= 128)
    }) {
        return Err(format!("{name} must be a non-empty string up to 128 bytes"));
    }
    Ok(())
}

fn validate_safe_integer(value: Option<&Value>, name: &str) -> Result<(), String> {
    if !value.is_some_and(|value| {
        value
            .as_i64()
            .is_some_and(|value| value >= 0 && value <= MAX_JAVASCRIPT_SAFE_INTEGER as i64)
    }) {
        return Err(format!(
            "{name} must be a non-negative JavaScript-safe integer"
        ));
    }
    Ok(())
}
