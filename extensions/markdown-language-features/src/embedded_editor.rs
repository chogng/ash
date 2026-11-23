use serde::Serialize;
use serde_json::Value;
use serde_json::value::RawValue;
use std::collections::BTreeMap;
use std::ops::Range;

const MAX_FORM_BYTES: usize = 16 * 1024;

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Editor {
    TaskProgress,
    JsonForm {
        fields: Vec<JsonField>,
        max_bytes: usize,
    },
}

#[derive(Debug, Serialize)]
pub(crate) struct JsonField {
    name: String,
    start: u32,
    end: u32,
    #[serde(flatten)]
    value: FieldValue,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
enum FieldValue {
    Text(String),
    Number(String),
    Boolean(bool),
    Null,
}

pub(crate) fn resolve(
    info: &str,
    source: &str,
    fence: &Range<usize>,
    offsets: &[u32],
) -> Option<Editor> {
    if !matches!(info, "widget:task-progress" | "widget:json")
        || !crate::parser::complete_code_fence(source, fence)
    {
        return None;
    }
    let fenced = &source[fence.clone()];
    let body_start = fence.start + fenced.find('\n')? + 1;
    let body_end = fence.start + fenced.rfind('\n')? + 1;
    let body = &source[body_start..body_end];
    match info {
        "widget:task-progress" if body.trim().is_empty() => Some(Editor::TaskProgress),
        "widget:json" if fenced.len() <= MAX_FORM_BYTES => {
            let fields = json_fields(body, body_start, offsets[fence.start], offsets)?;
            Some(Editor::JsonForm {
                fields,
                max_bytes: MAX_FORM_BYTES,
            })
        }
        _ => None,
    }
}

fn json_fields(
    body: &str,
    body_start: usize,
    fence_start: u32,
    offsets: &[u32],
) -> Option<Vec<JsonField>> {
    // Borrow original tokens so a form edit can leave the surrounding JSON intact.
    let object: BTreeMap<String, &RawValue> = serde_json::from_str(body).ok()?;
    if object.is_empty() || object.len() > 32 {
        return None;
    }
    let mut fields = Vec::with_capacity(object.len());
    for (name, token) in object {
        let token = token.get();
        let start = body_start + (token.as_ptr() as usize - body.as_ptr() as usize);
        let end = start + token.len();
        let value = match serde_json::from_str::<Value>(token).ok()? {
            Value::String(value) if !value.contains(['\n', '\r']) => FieldValue::Text(value),
            Value::Number(_) => FieldValue::Number(token.into()),
            Value::Bool(value) => FieldValue::Boolean(value),
            Value::Null => FieldValue::Null,
            Value::String(_) | Value::Array(_) | Value::Object(_) => return None,
        };
        fields.push(JsonField {
            name,
            start: offsets[start] - fence_start,
            end: offsets[end] - fence_start,
            value,
        });
    }
    fields.sort_unstable_by_key(|field| field.start);
    Some(fields)
}
