use super::ExtensionClientOperation;
use super::ExtensionClientRequest;
use super::ExtensionClientResult;
use crate::HostErrorCode;
use crate::ProtocolLimits;
use crate::RequestContext;
use serde_json::json;

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
