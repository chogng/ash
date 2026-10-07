use super::*;
use serde_json::json;

#[test]
fn application_host_roundtrip_preserves_explicit_identity_and_operation() {
    let wire = json!({"sessionId":"session-1","threadId":"thread-1","turnId":"turn-1","operation":{"type":"moveSession","sessionId":"session-2","sectionId":null}});
    let decoded: AppHostRequestParams = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), wire);
    assert!(
        serde_json::from_value::<AppHostOperation>(
            json!({"type":"confetti","targetWindow":"focused"})
        )
        .is_err()
    );
    assert!(
        serde_json::from_value::<AppToolsCapability>(json!({"version":1,"agents":true})).is_err()
    );
}
