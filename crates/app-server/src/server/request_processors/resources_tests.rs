use super::super::memory_diagnostics_processor::MemoryDiagnosticsRequestProcessor;
use super::ConnectionState;
use super::ResourceRequestProcessor;
use crate::resource_store::ResourceStore;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use base64::Engine;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;
use std::sync::Mutex;

#[test]
fn diagnostic_exports_share_resource_ownership_and_cleanup_without_a_server() {
    let store = Arc::new(Mutex::new(ResourceStore::default()));
    let diagnostics = MemoryDiagnosticsRequestProcessor::new(Arc::clone(&store));
    let resources = ResourceRequestProcessor::new(&store);
    let first = ConnectionState {
        connection_id: 1,
        ..ConnectionState::default()
    };
    let second = ConnectionState {
        connection_id: 2,
        ..ConnectionState::default()
    };
    let export = |connection: &ConnectionState| {
        let session = diagnostics
            .start(
                connection,
                &json!({"requestId":"export","product":"tui","durationSecs":60}),
            )
            .unwrap();
        let query = json!({"sessionId":session["sessionId"]});
        diagnostics.stop(connection, &query).unwrap();
        (session, diagnostics.export(connection, &query).unwrap())
    };
    let (session, first_export) = export(&first);
    let (_, second_export) = export(&second);
    let query = json!({"resourceId":first_export["resourceId"]});
    assert_eq!(
        resources.resource_metadata(&first, &query).unwrap(),
        first_export
    );
    assert_eq!(
        resources
            .resource_metadata(&second, &query)
            .unwrap_err()
            .message,
        AppServerErrorName::ResourceNotOwner
    );
    assert_eq!(
        resources
            .resource_release(&second, &query)
            .unwrap_err()
            .message,
        AppServerErrorName::ResourceNotOwner
    );

    let read = json!({"resourceId":first_export["resourceId"],"offset":0,"maxBytes":262144});
    let chunk = resources.resource_read(&first, &read).unwrap();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(chunk["dataBase64"].as_str().unwrap())
        .unwrap();
    let report: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(report["report"]["sessionId"], session["sessionId"]);
    assert_eq!(chunk["decodedLength"], bytes.len());
    assert_eq!(chunk["eof"], true);

    resources.connection_closed(first.connection_id);
    assert_eq!(
        resources
            .resource_metadata(&first, &query)
            .unwrap_err()
            .message,
        AppServerErrorName::ResourceNotFound
    );
    let second_query = json!({"resourceId":second_export["resourceId"]});
    assert_eq!(
        resources.resource_metadata(&second, &second_query).unwrap(),
        second_export
    );
    resources.resource_release(&second, &second_query).unwrap();
    assert_eq!(
        resources
            .resource_metadata(&second, &second_query)
            .unwrap_err()
            .message,
        AppServerErrorName::ResourceNotFound
    );
}
