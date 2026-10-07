use crate::CoreError;
use ash_protocol::ThreadItem;
use ash_protocol::ToolCallId;
use ash_protocol::ToolName;
use ash_protocol::TurnId;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;

pub(crate) const TOOL_REPETITION_REMINDER_THRESHOLD: u32 = 3;
pub(crate) const TOOL_REPETITION_FAILURE_THRESHOLD: u32 = 5;
pub(crate) const TOOL_REPETITION_REMINDER: &str = "Repeated tool failure reminder: this exact tool and arguments have failed three consecutive times. Change the approach, tool, or arguments before retrying.";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ToolFailureStreak {
    pub(crate) tool_name: ToolName,
    pub(crate) arguments_digest: String,
    pub(crate) count: u32,
}

#[derive(Default)]
pub(crate) struct ToolFailureProjection {
    active: Option<ToolFailureStreak>,
}

impl ToolFailureProjection {
    pub(crate) fn active(&self) -> Option<&ToolFailureStreak> {
        self.active.as_ref()
    }
}

pub(crate) fn project_tool_failures(
    items: &[ThreadItem],
    turn_id: &TurnId,
) -> Result<ToolFailureProjection, CoreError> {
    let mut identities = BTreeMap::new();
    for item in items {
        if let ThreadItem::ToolCall {
            turn_id: item_turn_id,
            tool_call_id,
            name,
            arguments_json,
            ..
        } = item
            && item_turn_id == turn_id
        {
            identities.insert(
                tool_call_id.clone(),
                ToolFailureIdentity {
                    tool_name: name.clone(),
                    arguments_digest: canonical_arguments_digest(arguments_json, tool_call_id)?,
                },
            );
        }
    }

    let mut projection = ToolFailureProjection::default();
    for item in items {
        let ThreadItem::ToolResult {
            turn_id: item_turn_id,
            tool_call_id,
            is_error,
            ..
        } = item
        else {
            continue;
        };
        if item_turn_id != turn_id {
            continue;
        }
        if !is_error {
            projection.active = None;
            continue;
        }
        let identity = identities.get(tool_call_id).ok_or_else(|| {
            CoreError::Journal(format!(
                "Tool Result references an unavailable Tool Call: {tool_call_id}"
            ))
        })?;
        let count = projection
            .active
            .as_ref()
            .filter(|active| active.matches(identity))
            .map(|active| active.count.saturating_add(1))
            .unwrap_or(1);
        projection.active = Some(ToolFailureStreak {
            tool_name: identity.tool_name.clone(),
            arguments_digest: identity.arguments_digest.clone(),
            count,
        });
    }
    Ok(projection)
}

pub(crate) fn next_tool_failure_count(
    items: &[ThreadItem],
    turn_id: &TurnId,
    tool_call_id: &ToolCallId,
    is_error: bool,
) -> Result<u32, CoreError> {
    if !is_error {
        return Ok(0);
    }
    let projection = project_tool_failures(items, turn_id)?;
    let identity = items
        .iter()
        .find_map(|item| match item {
            ThreadItem::ToolCall {
                turn_id: item_turn_id,
                tool_call_id: item_call_id,
                name,
                arguments_json,
                ..
            } if item_turn_id == turn_id && item_call_id == tool_call_id => {
                Some((name, arguments_json))
            }
            _ => None,
        })
        .ok_or_else(|| {
            CoreError::Journal(format!(
                "Tool Result references an unavailable Tool Call: {tool_call_id}"
            ))
        })?;
    let identity = ToolFailureIdentity {
        tool_name: identity.0.clone(),
        arguments_digest: canonical_arguments_digest(identity.1, tool_call_id)?,
    };
    Ok(projection
        .active()
        .filter(|active| active.matches(&identity))
        .map(|active| active.count.saturating_add(1))
        .unwrap_or(1))
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ToolFailureIdentity {
    tool_name: ToolName,
    arguments_digest: String,
}

impl ToolFailureStreak {
    fn matches(&self, identity: &ToolFailureIdentity) -> bool {
        self.tool_name == identity.tool_name && self.arguments_digest == identity.arguments_digest
    }
}

fn canonical_arguments_digest(
    arguments_json: &str,
    tool_call_id: &ToolCallId,
) -> Result<String, CoreError> {
    let mut arguments = serde_json::from_str(arguments_json).map_err(|error| {
        CoreError::Journal(format!(
            "durable Tool Call {tool_call_id} has invalid arguments: {error}"
        ))
    })?;
    canonicalize_json(&mut arguments);
    let encoded = serde_json::to_vec(&arguments).map_err(|error| {
        CoreError::Journal(format!(
            "failed to encode canonical arguments for Tool Call {tool_call_id}: {error}"
        ))
    })?;
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
mod tests {
    use super::*;
    use ash_protocol::ItemId;

    #[test]
    fn canonical_arguments_and_resets_define_the_consecutive_failure_window() {
        let turn_id = TurnId::new("turn").unwrap();
        let mut items = Vec::new();
        append_result(
            &mut items,
            &turn_id,
            "call-1",
            "search",
            r#"{"query":"ash","limit":5}"#,
            true,
        );
        append_result(
            &mut items,
            &turn_id,
            "call-2",
            "search",
            r#"{"limit":5,"query":"ash"}"#,
            true,
        );
        assert_eq!(
            project_tool_failures(&items, &turn_id)
                .unwrap()
                .active()
                .unwrap()
                .count,
            2
        );

        append_result(
            &mut items,
            &turn_id,
            "call-3",
            "search",
            r#"{"query":"different","limit":5}"#,
            true,
        );
        assert_eq!(
            project_tool_failures(&items, &turn_id)
                .unwrap()
                .active()
                .unwrap()
                .count,
            1
        );
        append_result(
            &mut items,
            &turn_id,
            "call-4",
            "fetch",
            r#"{"query":"different","limit":5}"#,
            true,
        );
        assert_eq!(
            project_tool_failures(&items, &turn_id)
                .unwrap()
                .active()
                .unwrap()
                .count,
            1
        );
        append_result(
            &mut items,
            &turn_id,
            "call-5",
            "fetch",
            r#"{"query":"different","limit":5}"#,
            false,
        );
        assert!(
            project_tool_failures(&items, &turn_id)
                .unwrap()
                .active()
                .is_none()
        );
    }

    #[test]
    fn interleaved_turns_keep_independent_failure_windows() {
        let first_turn = TurnId::new("first-turn").unwrap();
        let second_turn = TurnId::new("second-turn").unwrap();
        let mut items = Vec::new();
        for index in 1..=5 {
            append_result(
                &mut items,
                &first_turn,
                &format!("first-{index}"),
                "search",
                r#"{"query":"ash"}"#,
                true,
            );
            if index == 1 {
                append_result(
                    &mut items,
                    &second_turn,
                    "second-1",
                    "search",
                    r#"{"query":"ash"}"#,
                    true,
                );
            }
        }

        assert_eq!(
            project_tool_failures(&items, &first_turn)
                .unwrap()
                .active()
                .unwrap()
                .count,
            5
        );
        assert_eq!(
            project_tool_failures(&items, &second_turn)
                .unwrap()
                .active()
                .unwrap()
                .count,
            1
        );
    }

    fn append_result(
        items: &mut Vec<ThreadItem>,
        turn_id: &TurnId,
        call_id: &str,
        name: &str,
        arguments_json: &str,
        is_error: bool,
    ) {
        let tool_call_id = ToolCallId::new(call_id).unwrap();
        items.push(ThreadItem::ToolCall {
            item_id: ItemId::new(format!("{call_id}-call")).unwrap(),
            turn_id: turn_id.clone(),
            tool_call_id: tool_call_id.clone(),
            name: ToolName::new(name).unwrap(),
            arguments_json: arguments_json.into(),
            binding: None,
        });
        items.push(ThreadItem::ToolResult {
            item_id: ItemId::new(format!("{call_id}-result")).unwrap(),
            turn_id: turn_id.clone(),
            tool_call_id,
            text: if is_error { "failed" } else { "ok" }.into(),
            content: None,
            is_error,
        });
    }
}
