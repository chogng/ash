use serde_json::json;

use super::ExtensionHostOutputEvent;
use super::HostEventContext;
use super::HostOutputOperation;
use super::HostOutputSeverity;
use crate::ExtensionHostLimits;

#[test]
fn output_event_is_process_fenced_and_serializes_as_an_unsolicited_operation() {
    let event = ExtensionHostOutputEvent {
        context: HostEventContext::new(3, 9),
        operation: HostOutputOperation::Append {
            channel_id: "review".into(),
            text: "ready\n".into(),
            severity: HostOutputSeverity::Information,
            category: Some("lifecycle".into()),
        },
    };

    event.validate(&ExtensionHostLimits::default()).unwrap();
    let encoded = serde_json::to_value(&event).unwrap();
    let decoded: ExtensionHostOutputEvent = serde_json::from_value(encoded.clone()).unwrap();
    assert_eq!(decoded, event);
    assert_eq!(
        encoded.clone(),
        json!({
            "protocolVersion": 1,
            "incarnation": 3,
            "activationGeneration": 9,
            "operation": "append",
            "channelId": "review",
            "text": "ready\n",
            "severity": "information",
            "category": "lifecycle"
        })
    );
    let mut unknown = encoded;
    unknown["ambientAuthority"] = json!(true);
    assert!(serde_json::from_value::<ExtensionHostOutputEvent>(unknown).is_err());
}

#[test]
fn output_event_rejects_invalid_channel_identity_and_payload_quota() {
    let mut event = ExtensionHostOutputEvent {
        context: HostEventContext::new(3, 9),
        operation: HostOutputOperation::Append {
            channel_id: "not valid".into(),
            text: "ready".into(),
            severity: HostOutputSeverity::Log,
            category: None,
        },
    };
    assert!(event.validate(&ExtensionHostLimits::default()).is_err());

    event.operation = HostOutputOperation::Append {
        channel_id: "review".into(),
        text: "x".repeat(33),
        severity: HostOutputSeverity::Log,
        category: None,
    };
    let limits = ExtensionHostLimits {
        maximum_payload_bytes: 32,
        ..ExtensionHostLimits::default()
    };
    assert!(event.validate(&limits).is_err());
}
