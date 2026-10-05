use super::*;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::model::ContextReadResult;

struct ContextTransport {
    expected_scope: ContextReadScope,
    expected_detail: ContextReadDetail,
}
impl JsonRpcTransport for ContextTransport {
    fn round_trip(&mut self, request: &str) -> Result<String, ClientError> {
        let request: serde_json::Value = serde_json::from_str(request).unwrap();
        assert_eq!(request["method"], "context/read");
        assert_eq!(
            request["params"]["detail"],
            serde_json::to_value(self.expected_detail).unwrap()
        );
        assert_eq!(
            request["params"]["scope"],
            serde_json::to_value(&self.expected_scope).unwrap()
        );
        Ok(serde_json::json!({ "jsonrpc": "2.0", "id": request["id"], "result": ContextReadResult { tool_definitions: vec![], context: ModelContextInspection { model: None, estimated_tokens: 400, estimator_revision: "test".into(), categories: vec![], allocation: None, latest_request: None } } }).to_string())
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
        let mut client = AppServerClient::new(ContextTransport {
            expected_scope,
            expected_detail: ContextReadDetail::Usage,
        });
        let panel = load_panel(&mut client, scope, ContextReadDetail::Usage).unwrap();
        assert_eq!(panel.inspection.estimated_tokens, 400);
        assert_eq!(panel.inspection.latest_request, None);
    }
}

#[test]
fn context_diagnostics_explicitly_requests_definitions() {
    let mut client = AppServerClient::new(ContextTransport {
        expected_scope: ContextReadScope::Environment,
        expected_detail: ContextReadDetail::Diagnostics,
    });
    let panel = load_panel(&mut client, None, ContextReadDetail::Diagnostics).unwrap();
    assert_eq!(panel.title(), "Developer: Context diagnostics");
}

#[test]
fn tool_summary_is_read_only_for_keyboard_and_pointer_input() {
    let mut panel = panel(ModelContextInspection {
        model: None,
        estimated_tokens: 500,
        estimator_revision: "test".into(),
        allocation: None,
        latest_request: None,
        categories: vec![ash_protocol::ModelContextCategoryUsage {
            category: ModelContextCategory::SystemTools,
            tokens: 500,
            sources: vec![ash_protocol::ModelContextSourceUsage {
                name: "read_file".into(),
                tokens: 500,
            }],
        }],
    });
    let body = Rect::new(0, 0, 80, 24);
    let list = panel.context_areas(body)[1];
    for x in list.x..list.right() {
        assert!(
            panel
                .pointer_target_at(body, Position::new(x, list.y))
                .is_none()
        );
    }
    assert_eq!(
        panel.pages.selected_item().unwrap().id(),
        Some(&ListSelectionItemId::new("category-1"))
    );
    let before = panel.body_rows(body.width);
    for code in [
        crossterm::event::KeyCode::Enter,
        crossterm::event::KeyCode::Right,
    ] {
        panel.handle_key(
            KeyEvent::new(code, crossterm::event::KeyModifiers::NONE),
            body,
        );
        assert_eq!(panel.body_rows(body.width), before);
    }
}
