use super::GeneratedFileChanged;
use super::GeneratedFileDto;
use super::GeneratedFileRegisterParams;
use crate::protocol::registry::ServerNotification;
use crate::protocol::registry::client_method_definition;
use crate::protocol::registry::decode_server_notification;
use serde_json::json;

#[test]
fn generated_files_wire_contract_keeps_sources_null_accounts_and_numeric_creation_time() {
    let file = json!({
        "id":"a".repeat(64), "resource":"ash-profile:/generated/review.md",
        "title":"Review", "contentType":"text/markdown",
        "source":{"providerId":"provider", "accountId":null, "sessionId":"session",
            "threadId":"thread", "itemId":"item", "partId":"part"}
    });
    let params = json!({"clientId":"ui", "file":file});
    let parsed: GeneratedFileRegisterParams = serde_json::from_value(params.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), params);
    let mut record = file;
    record["createdAt"] = json!(1794432000000_i64);
    let parsed: GeneratedFileDto = serde_json::from_value(record.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), record);
    let mut invalid = params;
    invalid["file"]["createdAt"] = json!(1);
    assert!(serde_json::from_value::<GeneratedFileRegisterParams>(invalid.clone()).is_err());
    invalid["file"].as_object_mut().unwrap().remove("createdAt");
    invalid["file"]["content"] = json!("body must remain in the file provider");
    assert!(serde_json::from_value::<GeneratedFileRegisterParams>(invalid).is_err());
}

#[test]
fn generated_files_methods_and_invalidation_are_registered_for_generated_decoders() {
    for (method, params_name, response_name) in [
        (
            "generatedFile/register",
            "GeneratedFileRegisterParams",
            "GeneratedFileRegisterResult",
        ),
        (
            "generatedFile/list",
            "GeneratedFileListParams",
            "GeneratedFileListResult",
        ),
    ] {
        let definition = client_method_definition(method).unwrap();
        assert_eq!(definition.params_type(), params_name);
        assert_eq!(definition.result_type(), response_name);
        assert_eq!(
            definition
                .serialization_scope(&json!({"clientId":"ui"}))
                .unwrap(),
            None
        );
    }
    let params = json!({"clientId":"ui"});
    let decoded =
        decode_server_notification("generatedFile/changed".into(), params.clone()).unwrap();
    assert!(
        matches!(decoded, ServerNotification::GeneratedFileChanged(GeneratedFileChanged { client_id }) if client_id == "ui")
    );
    let changed: GeneratedFileChanged = serde_json::from_value(params.clone()).unwrap();
    assert_eq!(serde_json::to_value(changed).unwrap(), params);
    assert!(
        decode_server_notification(
            "generatedFile/changed".into(),
            json!({"clientId":"ui", "file":{}})
        )
        .is_err()
    );
}
