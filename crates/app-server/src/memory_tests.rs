use super::call;
use super::initialize;
use super::server;
use serde_json::json;

#[test]
fn memory_protocol_records_exports_and_cleans_up_connection_owned_sessions() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let start = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":2,"method":"memoryDiagnostics/start","params":{"requestId":"diagnostic","product":"tui","durationSecs":600}}),
    );
    let id = start["result"]["sessionId"].as_str().unwrap();
    let repeated = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":3,"method":"memoryDiagnostics/start","params":{"requestId":"diagnostic","product":"tui","durationSecs":600}}),
    );
    assert_eq!(repeated["result"]["sessionId"], id);
    let evidence = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":4,"method":"memoryDiagnostics/submit","params":{"sessionId":id,"sequence":1,"observations":[{"instanceId":"local:123:456","processId":123,"role":"tui","phase":"idle","metrics":[{"kind":"uiObjects","value":10,"unavailable":null}]}]}}),
    );
    assert!(evidence.get("result").is_some(), "{evidence}");
    let mut other = server.connection();
    initialize(&server, &mut other);
    let denied = call(
        &server,
        &mut other,
        json!({"jsonrpc":"2.0","id":2,"method":"memoryDiagnostics/read","params":{"sessionId":id}}),
    );
    assert!(denied.get("error").is_some());
    let stopped = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":5,"method":"memoryDiagnostics/stop","params":{"sessionId":id}}),
    );
    assert_eq!(stopped["result"]["status"], "stopped");
    let export = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":6,"method":"memoryDiagnostics/export","params":{"sessionId":id}}),
    );
    let resource = export["result"]["resourceId"].as_str().unwrap();
    let bytes = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":7,"method":"resource/read","params":{"resourceId":resource,"offset":0,"maxBytes":262144}}),
    );
    assert!(bytes["result"]["decodedLength"].as_u64().unwrap() > 0);
    server.close_connection(connection.clone());
    let closed = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":8,"method":"memoryDiagnostics/start","params":{"requestId":"after-close","product":"tui","durationSecs":600}}),
    );
    assert!(closed.get("error").is_some());
    server.close_connection(other);
}
