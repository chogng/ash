use super::ExtensionClientOperation;
use super::ExtensionClientRequest;
use super::ExtensionClientResult;
use crate::HostErrorCode;
use crate::ProtocolLimits;
use crate::RequestContext;
use serde_json::json;

#[test]
fn status_bar_updates_round_trip_and_reject_duplicate_ids_and_forged_owners() {
    let value = json!({
        "context": {"protocolVersion":1,"requestId":41,"incarnation":3,"activationGeneration":7},
        "callId":9, "operation": {"operation":"setStatusBarEntries","registrationId":"status","revision":2,"entries":[{
            "id":"item.1","text":"Ready","tooltip":null,"ariaLabel":"Run","alignment":"right","priority":1.5,
            "command":{"command":"example.run","arguments":[{"value":2}]}
        }]}
    });
    let request: ExtensionClientRequest = serde_json::from_value(value.clone()).unwrap();
    request.validate(&ProtocolLimits::default()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), value);
    let mut duplicate = value.clone();
    duplicate["operation"]["entries"] = json!([
        value["operation"]["entries"][0],
        value["operation"]["entries"][0]
    ]);
    assert!(
        serde_json::from_value::<ExtensionClientRequest>(duplicate)
            .unwrap()
            .validate(&ProtocolLimits::default())
            .is_err()
    );
    let mut invalid = value.clone();
    invalid["operation"]["revision"] = json!(0);
    assert!(
        serde_json::from_value::<ExtensionClientRequest>(invalid)
            .unwrap()
            .validate(&ProtocolLimits::default())
            .is_err()
    );
    let mut forged = value;
    forged["operation"]["extensionId"] = json!("other");
    assert!(serde_json::from_value::<ExtensionClientRequest>(forged).is_err());
}

#[test]
fn diagnostic_replacements_preserve_versions_and_reject_forged_ownership_and_invalid_ranges() {
    let value = json!({
        "context": {"protocolVersion":1,"requestId":41,"incarnation":3,"activationGeneration":7},
        "callId":9, "operation": {"operation":"setDiagnostics","collection":"lint","entries":[{
            "uri":"file:///main.ts", "version":7, "diagnostics":[{
                "start":{"line":0,"character":2}, "end":{"line":0,"character":4},
                "message":"Check this", "severity":"warning", "source":"test", "code":null
            }]
        }]}
    });
    let request: ExtensionClientRequest = serde_json::from_value(value.clone()).unwrap();
    request.validate(&ProtocolLimits::default()).unwrap();
    assert_eq!(serde_json::to_value(&request).unwrap(), value);
    let mut invalid = value.clone();
    invalid["operation"]["entries"][0]["diagnostics"][0]["end"]["character"] = json!(1);
    assert!(
        serde_json::from_value::<ExtensionClientRequest>(invalid)
            .unwrap()
            .validate(&ProtocolLimits::default())
            .is_err()
    );
    let mut forged = value;
    forged["operation"]["extensionId"] = json!("other");
    assert!(serde_json::from_value::<ExtensionClientRequest>(forged).is_err());
}

#[test]
fn workspace_read_preserves_parent_identity_and_has_a_distinct_disk_result() {
    let request = ExtensionClientRequest {
        context: RequestContext {
            protocol_version: 1,
            request_id: 41,
            incarnation: 3,
            activation_generation: 7,
        },
        call_id: 9,
        operation: ExtensionClientOperation::ReadWorkspaceFile {
            path: "src/main.rs".into(),
        },
    };
    request.validate(&ProtocolLimits::default()).unwrap();
    let value = serde_json::to_value(&request).unwrap();
    assert_eq!(
        value,
        json!({"context":{"protocolVersion":1,"requestId":41,"incarnation":3,"activationGeneration":7},"callId":9,"operation":{"operation":"readWorkspaceFile","path":"src/main.rs"}})
    );
    assert_eq!(
        serde_json::from_value::<ExtensionClientRequest>(value).unwrap(),
        request
    );
    assert_eq!(
        serde_json::to_value(ExtensionClientResult::File {
            text: "on disk".into()
        })
        .unwrap(),
        json!({"result":"file","text":"on disk"})
    );
    assert!(
        serde_json::from_value::<ExtensionClientOperation>(
            json!({"operation":"readWorkspaceFile","path":"src/main.rs","extensionId":"forged"})
        )
        .is_err()
    );
    assert_eq!(
        serde_json::to_value(HostErrorCode::PermissionDenied).unwrap(),
        json!("permissionDenied")
    );
}
