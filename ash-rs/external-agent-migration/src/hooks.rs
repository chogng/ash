use std::collections::BTreeMap;

use serde_json::Value as JsonValue;

use crate::plan::ExternalHookEvent;

const GROUP_ALLOWED_FIELDS: [&str; 2] = ["matcher", "hooks"];
const COMMAND_HOOK_ALLOWED_FIELDS: [&str; 6] = [
    "type",
    "command",
    "timeout",
    "timeoutSec",
    "statusMessage",
    "async",
];
/// Claude hook fields this crate cannot represent, matching upstream conversion skips.
const UNSUPPORTED_HOOK_FIELDS: [&str; 3] = ["asyncRewake", "shell", "once"];

/// Groups external Claude hook configuration by source event name.
///
/// `groups` counts every declared group for the event; `command_groups` counts only groups where
/// every hook is a well-formed, non-async command hook. Mapping source event names onto Ash hook
/// events stays with the caller's adapter.
pub(crate) fn claude_hook_events(settings: &JsonValue) -> Vec<ExternalHookEvent> {
    let Some(hooks) = settings.get("hooks").and_then(JsonValue::as_object) else {
        return Vec::new();
    };

    let mut events: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for (event_name, groups) in hooks {
        let Some(groups) = groups.as_array() else {
            continue;
        };
        for group in groups {
            let Some(group) = group.as_object() else {
                continue;
            };
            let entry = events.entry(event_name.clone()).or_insert_with(|| (0, 0));
            entry.0 += 1;
            if is_convertible_group(group) {
                entry.1 += 1;
            }
        }
    }

    events
        .into_iter()
        .map(|(event, (groups, command_groups))| ExternalHookEvent {
            event,
            groups,
            command_groups,
        })
        .collect()
}

fn is_convertible_group(group: &serde_json::Map<String, JsonValue>) -> bool {
    if group.contains_key("if")
        || group
            .keys()
            .any(|key| !GROUP_ALLOWED_FIELDS.contains(&key.as_str()))
    {
        return false;
    }
    let Some(hooks) = group.get("hooks").and_then(JsonValue::as_array) else {
        return false;
    };
    !hooks.is_empty()
        && hooks
            .iter()
            .all(|hook| hook.as_object().is_some_and(is_convertible_command_hook))
}

fn is_convertible_command_hook(hook: &serde_json::Map<String, JsonValue>) -> bool {
    let hook_type = hook
        .get("type")
        .and_then(JsonValue::as_str)
        .unwrap_or("command");
    if hook_type != "command"
        || hook
            .get("async")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false)
        || UNSUPPORTED_HOOK_FIELDS
            .into_iter()
            .any(|field| hook.contains_key(field))
        || hook
            .keys()
            .any(|key| !COMMAND_HOOK_ALLOWED_FIELDS.contains(&key.as_str()))
    {
        return false;
    }
    hook.get("command")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .is_some_and(|command| !command.is_empty())
}

#[cfg(test)]
#[path = "hooks_tests.rs"]
mod tests;
