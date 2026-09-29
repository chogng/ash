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
