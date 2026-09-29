use super::SessionCreateParams;
use serde_json::json;

#[test]
fn session_create_selects_the_current_workspace_and_serializes_named_worktrees() {
    let existing = json!({
        "agent": { "type": "default" },
        "commandId": "create-session",
        "title": "topic",
        "workspace": { "type": "current" }
    });
    let mut params: SessionCreateParams = serde_json::from_value(existing.clone()).unwrap();
    assert_eq!(params.branch_name, None);
    assert_eq!(serde_json::to_value(&params).unwrap(), existing);

    params.branch_name = Some("ash/topic".into());
    assert_eq!(
        serde_json::to_value(&params).unwrap(),
        json!({
            "agent": { "type": "default" },
            "commandId": "create-session",
            "title": "topic",
            "workspace": { "type": "current" },
            "branchName": "ash/topic"
        })
    );
}
