use super::ConnectionState;
use super::MemoryDiagnosticsRequestProcessor;
use super::ResourceStore;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;
use std::sync::Mutex;

#[test]
fn memory_processor_records_and_exports_without_an_app_server() {
    let resources = Arc::new(Mutex::new(ResourceStore::default()));
    let processor = MemoryDiagnosticsRequestProcessor::new(Arc::clone(&resources));
    let first = ConnectionState {
        connection_id: 1,
        ..ConnectionState::default()
    };
    let second = ConnectionState {
        connection_id: 2,
        ..ConnectionState::default()
    };
    let request = json!({"requestId":"recording","product":"tui","durationSecs":600});
    let first_session = processor.start(&first, &request).unwrap();
    let second_session = processor.start(&second, &request).unwrap();
    assert_ne!(first_session["sessionId"], second_session["sessionId"]);
    assert_eq!(
        processor.start(&first, &request).unwrap()["sessionId"],
        first_session["sessionId"]
    );
    let session = json!({"sessionId":first_session["sessionId"]});
    assert_eq!(
        processor.read(&second, &session).unwrap_err().message,
        AppServerErrorName::MemoryDiagnosticsNotFound
    );
    processor
        .submit(
            &first,
            &json!({
                "sessionId":first_session["sessionId"],
                "sequence":1,
                "observations":[{
                    "instanceId":"test-ui",
                    "processId":null,
                    "role":"tui",
                    "phase":"idle",
                    "metrics":[{"kind":"uiObjects","value":10,"unavailable":null}]
                }]
            }),
        )
        .unwrap();
    assert_eq!(
        processor.stop(&first, &session).unwrap()["status"],
        "stopped"
    );
    let export = processor.export(&first, &session).unwrap();
    let resource_id = export["resourceId"].as_str().unwrap();
    let bundle = {
        let mut resources = resources.lock().unwrap();
        assert!(
            resources
                .metadata(second.connection_id, resource_id)
                .is_err()
        );
        let chunk = resources
            .read(first.connection_id, resource_id, 0, 262_144)
            .unwrap();
        assert!(chunk.eof);
        serde_json::from_slice::<Value>(&chunk.data).unwrap()
    };
    let report = &bundle["report"];
    assert_eq!(report["sessionId"], first_session["sessionId"]);
    assert!(report["targets"].as_array().unwrap().iter().any(|target| {
        target["instanceId"] == "test-ui" && target["latest"]["metrics"][0]["value"] == 10
    }));

    assert!(first.mark_closed());
    processor.connection_closed(first.connection_id);
    // Closing one connection retires its recordings without touching another owner's.
    assert_eq!(
        processor.diagnostics.read(
            first.connection_id,
            first_session["sessionId"].as_str().unwrap()
        ),
        Err(ash_memory_diagnostics::MemoryDiagnosticsError::NotFound)
    );
    assert!(
        processor
            .read(&second, &json!({"sessionId":second_session["sessionId"]}))
            .is_ok()
    );
}

#[test]
fn memory_processor_rejects_closed_connections_before_decoding() {
    let resources = Arc::new(Mutex::new(ResourceStore::default()));
    let processor = MemoryDiagnosticsRequestProcessor::new(Arc::clone(&resources));
    let connection = ConnectionState::default();
    assert!(connection.mark_closed());
    let operations = [
        MemoryDiagnosticsRequestProcessor::start,
        MemoryDiagnosticsRequestProcessor::read,
        MemoryDiagnosticsRequestProcessor::stop,
        MemoryDiagnosticsRequestProcessor::submit,
        MemoryDiagnosticsRequestProcessor::export,
    ];
    for operation in operations {
        let error = operation(&processor, &connection, &Value::Null).unwrap_err();
        assert_eq!(error.code, -32800);
        assert_eq!(error.message, AppServerErrorName::RequestCancelled);
    }
}
