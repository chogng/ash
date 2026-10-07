use super::SessionCreateParams;
use serde_json::json;

#[test]
fn session_create_serializes_execution_target_and_named_worktrees() {
    let existing = json!({
        "agent": { "type": "default" },
        "commandId": "create-session",
        "title": "topic",
        "executionTarget": { "type": "local", "root": "/repo" }
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
            "executionTarget": { "type": "local", "root": "/repo" },
            "branchName": "ash/topic"
        })
    );
}

#[test]
fn session_create_accepts_an_unscoped_target_but_no_implicit_current_variant() {
    let unscoped = json!({
        "commandId": "create-session",
        "title": "topic",
        "executionTarget": null
    });
    let params: SessionCreateParams = serde_json::from_value(unscoped.clone()).unwrap();
    assert_eq!(params.execution_target, None);
    assert_eq!(
        serde_json::to_value(params).unwrap(),
        json!({
            "agent": { "type": "default" },
            "commandId": "create-session",
            "title": "topic",
            "executionTarget": null
        })
    );
    assert!(
        serde_json::from_value::<SessionCreateParams>(json!({
            "commandId": "create-session",
            "title": "topic",
            "executionTarget": { "type": "current" }
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<SessionCreateParams>(json!({
            "commandId": "create-session",
            "title": "topic"
        }))
        .is_err()
    );
}
