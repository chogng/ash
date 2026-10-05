use super::*;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::model::ContextReadResult;

struct ContextTransport {
    expected_scope: ContextReadScope,
}
impl JsonRpcTransport for ContextTransport {
    fn round_trip(&mut self, request: &str) -> Result<String, ClientError> {
        let request: serde_json::Value = serde_json::from_str(request).unwrap();
        assert_eq!(request["method"], "context/read");
        assert_eq!(
            request["params"]["scope"],
            serde_json::to_value(&self.expected_scope).unwrap()
        );
        Ok(serde_json::json!({ "jsonrpc": "2.0", "id": request["id"], "result": ContextReadResult { context: ModelContextInspection { model: None, estimated_tokens: 400, estimator_revision: "test".into(), categories: vec![], allocation: None, latest_request: None } } }).to_string())
    }
}

#[test]
fn context_panel_reads_environment_before_any_request_and_preserves_thread_scope() {
    let session_id = SessionId::new("session").unwrap();
    let thread_id = ThreadId::new("thread").unwrap();
    for scope in [
        None,
        Some(RequestScope {
            session_id: &session_id,
            thread_id: &thread_id,
        }),
    ] {
        let expected_scope = match &scope {
            None => ContextReadScope::Environment,
            Some(scope) => ContextReadScope::Thread {
                session_id: scope.session_id.clone(),
                thread_id: scope.thread_id.clone(),
            },
        };
        let mut client = AppServerClient::new(ContextTransport { expected_scope });
        let panel = load_panel(&mut client, scope).unwrap();
        assert_eq!(panel.inspection.estimated_tokens, 400);
        assert_eq!(panel.inspection.latest_request, None);
    }
}
