use serde_json::json;

use super::claude_hook_events;

#[test]
fn settings_without_hooks_yield_no_events() {
    assert!(claude_hook_events(&json!({"model": "claude"})).is_empty());
    assert!(claude_hook_events(&json!({"hooks": {"PreToolUse": "not-an-array"}})).is_empty());
}

#[test]
fn hook_groups_count_per_event_and_sort_by_name() {
    let settings = json!({
        "hooks": {
            "PostToolUse": [{"hooks": [{"type": "command", "command": "after"}]}],
            "PreToolUse": [
                {"matcher": "Bash", "hooks": [{"command": "before"}]},
                {"hooks": []}
            ]
        }
    });

    let events = claude_hook_events(&settings);
    assert_eq!(events.len(), 2);
    let pre = events
        .iter()
        .find(|event| event.event == "PreToolUse")
        .unwrap();
    assert_eq!(pre.groups, 2);
    assert_eq!(pre.command_groups, 1);
    let post = events
        .iter()
        .find(|event| event.event == "PostToolUse")
        .unwrap();
    assert_eq!(post.groups, 1);
    assert_eq!(post.command_groups, 1);
}

#[test]
fn groups_with_unknown_fields_are_not_convertible() {
    let settings = json!({
        "hooks": {
            "PreToolUse": [
                {"hooks": [{"command": "ok"}]},
                {"if": "condition", "hooks": [{"command": "skipped"}]},
                {"hooks": [{"command": "gone"}, {"type": "prompt", "prompt": "nope"}]}
            ]
        }
    });

    let events = claude_hook_events(&settings);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].groups, 3);
    assert_eq!(events[0].command_groups, 1);
}

#[test]
fn async_and_special_hooks_are_not_convertible() {
    let settings = json!({
        "hooks": {
            "Stop": [
                {"hooks": [{"command": "late", "async": true}]},
                {"hooks": [{"command": "task", "asyncRewake": true}]},
                {"hooks": [{"command": ""}]},
                {"hooks": [{"command": "kept", "timeout": 30}]}
            ]
        }
    });

    let events = claude_hook_events(&settings);
    assert_eq!(events[0].groups, 4);
    assert_eq!(events[0].command_groups, 1);
}
