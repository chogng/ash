use super::BrowserConfigureParams;
use super::BrowserPerformActionDto;
use super::BrowserPerformParams;
use super::BrowserPerformResult;
use serde_json::json;

#[test]
fn browser_protocol_preserves_cdp_parameters_and_created_target_identity() {
    let value = json!({
        "type": "cdp", "targetId": "page", "operation": {
            "type": "command", "method": "Runtime.evaluate",
            "params": { "expression": "1 + 1", "awaitPromise": true }, "sessionId": "child"
        }
    });
    let action: BrowserPerformActionDto = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(action.target_id(), "page");
    assert_eq!(serde_json::to_value(action).unwrap(), value);
    let result: BrowserPerformResult = serde_json::from_value(json!({
        "targetId": "page", "createdTargetId": "new-page", "output": "{}"
    }))
    .unwrap();
    assert_eq!(result.created_target_id.as_deref(), Some("new-page"));
}

#[test]
fn browser_protocol_rejects_ambiguous_configuration_and_cdp_operation_fields() {
    assert!(
        serde_json::from_value::<BrowserConfigureParams>(json!({
            "enabled": true, "cdpEnabled": true, "threadId": "other"
        }))
        .is_err()
    );
    assert!(serde_json::from_value::<BrowserPerformActionDto>(json!({
        "type": "cdp", "targetId": "page", "operation": { "type": "close", "method": "Runtime.evaluate" }
    })).is_err());
}

#[test]
fn browser_protocol_carries_upload_bytes_separately_from_untrusted_cdp_paths() {
    let value = json!({
        "threadId":"thread", "uploads":[{"name":"allowed.txt","dataBase64":"YWxsb3dlZA=="}],
        "action":{"type":"cdp","targetId":"page","operation":{
            "type":"command","method":"DOM.setFileInputFiles",
            "params":{"files":["/project/allowed.txt"],"backendNodeId":1}
        }}
    });
    let params: BrowserPerformParams = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(params).unwrap(), value);
    assert!(
        serde_json::from_value::<super::BrowserUploadFile>(json!({
            "name":"file", "dataBase64":"", "path":"/unapproved/file"
        }))
        .is_err()
    );
}
