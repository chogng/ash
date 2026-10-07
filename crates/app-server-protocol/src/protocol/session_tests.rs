use super::SessionCreateParams;
use super::SessionTraceReadParams;
use serde_json::json;

#[test]
fn diagnostic_read_boundaries_round_trip_and_reject_paths_or_unknown_fields() {
    use super::SessionTraceDiagnosticsReadParams;
    use super::SessionTracePayloadReadParams;
    let value = json!({ "sessionId": "session", "after": 5, "limit": 20 });
    let params: SessionTraceDiagnosticsReadParams = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(params).unwrap(), value);
    assert_eq!(
        serde_json::from_value::<SessionTraceDiagnosticsReadParams>(
            json!({ "sessionId": "session", "limit": 20 })
        )
        .unwrap()
        .after,
        0
    );
    for invalid in [
        json!({ "sessionId": "session", "after": -1, "limit": 20 }),
        json!({ "sessionId": "session", "after": 1.5, "limit": 20 }),
        json!({ "sessionId": "session", "path": "/trace", "limit": 20 }),
    ] {
        assert!(serde_json::from_value::<SessionTraceDiagnosticsReadParams>(invalid).is_err());
    }
    let payload =
        json!({ "sessionId": "session", "captureId": "capture", "payloadId": "payload-1" });
    assert_eq!(
        serde_json::to_value(
            serde_json::from_value::<SessionTracePayloadReadParams>(payload.clone()).unwrap()
        )
        .unwrap(),
        payload
    );
    assert!(serde_json::from_value::<SessionTracePayloadReadParams>(json!({ "sessionId": "session", "captureId": "capture", "payloadId": "payload-1", "path": "/secret" })).is_err());
}

#[test]
fn trace_cursors_are_thread_local_and_reject_unknown_envelope_fields() {
    let value = json!({"sessionId":"session", "after":{"root":7,"child":2},"limit":100});
    let params: SessionTraceReadParams = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(params).unwrap(), value);
    let initial: SessionTraceReadParams =
        serde_json::from_value(json!({"sessionId":"session","limit":50})).unwrap();
    assert!(initial.after.is_empty());
    for invalid in [
        json!({"sessionId":"session","afterSequence":7,"limit":100}),
        json!({"sessionId":"session","after":{"root":-1},"limit":100}),
        json!({"sessionId":"session","after":{"root":1.5},"limit":100}),
    ] {
        assert!(serde_json::from_value::<SessionTraceReadParams>(invalid).is_err());
    }
}

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
