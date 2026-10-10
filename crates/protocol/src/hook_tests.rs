use super::HookEvent;
use std::collections::BTreeSet;

#[test]
fn hook_catalog_has_thirty_three_distinct_wire_events() {
    let names = HookEvent::ALL
        .into_iter()
        .map(|event| serde_json::to_string(&event).unwrap())
        .collect::<BTreeSet<_>>();
    assert_eq!(names.len(), 33);
    assert!(names.contains("\"preToolUse\""));
    assert!(names.contains("\"messageDisplay\""));
    for name in names {
        let event: HookEvent = serde_json::from_str(&name).unwrap();
        assert!(HookEvent::ALL.contains(&event));
    }
}

#[test]
fn hook_observation_roundtrips_stable_identity_and_terminal_feedback() {
    let event = crate::ThreadEvent::HookRunUpdated {
        thread_id: crate::ThreadId::new("thread").unwrap(),
        run: crate::HookRunRecord {
            run_id: "run".into(),
            hook_id: "user:hook:test".into(),
            event: HookEvent::PreToolUse,
            status: crate::HookRunStatus::Denied {
                reason: "blocked".into(),
            },
            started_at_unix_ms: 1,
            duration_ms: 7,
            turn_id: Some(crate::TurnId::new("turn").unwrap()),
            tool_call_id: Some(crate::ToolCallId::new("tool").unwrap()),
            tool_name: Some("shell-command".into()),
        },
    };
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["type"], "hookRunUpdated");
    assert_eq!(
        json["run"]["status"],
        serde_json::json!({"type":"denied", "reason":"blocked"})
    );
    assert_eq!(
        serde_json::from_value::<crate::ThreadEvent>(json).unwrap(),
        event
    );
}
