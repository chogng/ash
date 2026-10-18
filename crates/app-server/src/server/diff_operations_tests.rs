use super::DiffRequestProcessor;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use serde_json::json;

#[test]
fn dispatches_diff_and_preserves_protocol_errors() {
    let result = DiffRequestProcessor::new(ash_app_server_diff::compute)
        .diff_compute(&json!({"original": "before 😀 after", "modified": "before 🤖 after"}))
        .unwrap();
    assert_eq!(
        result["rows"][0]["originalChanges"][0],
        json!({"startColumn": 7, "endColumn": 9})
    );
    let error = DiffRequestProcessor::new(ash_app_server_diff::compute)
        .diff_compute(&json!({"original": null, "modified": ""}))
        .unwrap_err();
    assert_eq!(error.code, -32602);
    assert_eq!(error.message, AppServerErrorName::InvalidParams);
}

#[test]
fn dispatch_uses_the_supplied_adapter_and_its_error_kind() {
    fn adapter(
        params: &serde_json::Value,
    ) -> Result<serde_json::Value, ash_app_server_protocol::protocol::error::AppServerError> {
        if params.is_null() {
            Err(
                ash_app_server_protocol::protocol::error::AppServerError::new(
                    -32070,
                    AppServerErrorName::DiffOperationFailed,
                ),
            )
        } else {
            Ok(json!({"adapterResult": params}))
        }
    }
    let processor = DiffRequestProcessor::new(adapter);
    assert_eq!(
        processor.diff_compute(&json!({"input": 7})).unwrap(),
        json!({"adapterResult": {"input": 7}})
    );
    let error = processor.diff_compute(&json!(null)).unwrap_err();
    assert_eq!(error.code, -32070);
    assert_eq!(error.message, AppServerErrorName::DiffOperationFailed);
}
