use super::*;
use serde_json::json;
use std::collections::VecDeque;

struct Transport {
    results: VecDeque<Value>,
    methods: Vec<String>,
}

impl JsonRpcTransport for Transport {
    fn round_trip(&mut self, request: &str) -> Result<String, ClientError> {
        let request: Value = serde_json::from_str(request).unwrap();
        self.methods
            .push(request["method"].as_str().unwrap().into());
        Ok(json!({"jsonrpc": "2.0", "id": request["id"], "result": self.results.pop_front().unwrap()}).to_string())
    }
}

fn trace_page(session: &str, has_more: bool) -> Value {
    json!({"trace": {"formatVersion": 3, "sessionId": session, "threads": [], "historyPrefixes": []}, "cursors": {}, "hasMore": has_more})
}

#[test]
fn export_uses_existing_authorized_protocol_reads_and_includes_hook_payload() {
    let diagnostics = json!({
        "formatVersion": 2, "captureId": "capture", "recordingStatus": "recording", "droppedRecords": 0, "pendingRecords": 0,
        "events": [{"eventId": "event-1", "sequence": 1, "recordedAt": 0, "threadId": "thread", "turnId": null,
            "event": {"type": "hookRunRecorded", "runId": "hook", "executionPayload": {"payloadId": "payload-1", "kind": "hookExecution", "byteLength": 1, "status": "saved", "digest": null}}}]
    });
    let mut client = AppServerClient::new(Transport {
        results: VecDeque::from([
            trace_page("session", false),
            json!({"diagnostics": diagnostics, "cursor": 1, "hasMore": false}),
            json!({"payload": {"hook": "body"}}),
        ]),
        methods: Vec::new(),
    });
    let artifact = client
        .export_session_trace(&SessionId::new("session").unwrap())
        .unwrap();
    assert_eq!(
        artifact.diagnostics.unwrap().payloads["payload-1"],
        json!({"hook": "body"})
    );
    assert!(artifact.graph.is_some());
    assert_eq!(
        client.into_transport().methods,
        [
            "session/trace/read",
            "session/trace/diagnostics/read",
            "session/trace/payload/read"
        ]
    );
}

#[test]
fn export_rejects_foreign_identity_and_nonadvancing_pagination() {
    for page in [
        trace_page("foreign-session", false),
        trace_page("session", true),
    ] {
        let mut client = AppServerClient::new(Transport {
            results: VecDeque::from([page]),
            methods: Vec::new(),
        });
        assert!(matches!(
            client.export_session_trace(&SessionId::new("session").unwrap()),
            Err(ClientError::Protocol(_))
        ));
    }
}
