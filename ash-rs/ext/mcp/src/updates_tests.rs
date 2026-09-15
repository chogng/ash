use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use core_api::CoreError;
use ash_core::ToolInteractionService;
use ash_core::ToolUserInputOutcome;
use ash_protocol::RequestUserInput;
use ash_protocol::RequestUserInputResponse;
use ash_protocol::UserInputAnswer;
use ash_rmcp_client::ElicitRequestParams;
use ash_rmcp_client::ElicitationAction;
use ash_rmcp_client::McpClientEvent;
use ash_rmcp_client::McpElicitation;
use ash_rmcp_client::McpRequestId;

use super::McpCatalogUpdates;
use super::with_active_tool_interactions;

#[test]
fn tool_list_changes_publish_reconcile_hints_but_other_events_do_not() {
    let updates = McpCatalogUpdates::default();
    let lifecycle = Arc::new(CatalogLifecycle::default());
    let mut builder = extension_api::ExtensionRegistryBuilder::new();
    builder.mcp_lifecycle_contributor("test", lifecycle.clone());
    updates.bind_extensions(Arc::new(builder.build()));
    let subscription = updates.subscribe();
    let host = updates.client_host();

    host.on_event(McpClientEvent::ResourceListChanged);
    assert!(subscription.try_recv().is_err());

    host.on_event(McpClientEvent::ToolListChanged);
    subscription
        .recv_timeout(Duration::from_secs(1))
        .expect("tool list change must request reconciliation");
    assert_eq!(*lifecycle.0.lock().unwrap(), 1);
}

struct TestInteractions {
    answer: String,
    requests: Mutex<Vec<RequestUserInput>>,
}

impl ToolInteractionService for TestInteractions {
    fn approve_network(
        &self,
        _: &ash_action_policy::ActionReviewRequest,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<ash_protocol::ActionApprovalDecision, CoreError> {
        panic!("MCP elicitation must not request network approval")
    }

    fn request_user_input(
        &self,
        request: RequestUserInput,
    ) -> Result<ToolUserInputOutcome, CoreError> {
        self.requests.lock().unwrap().push(request);
        Ok(ToolUserInputOutcome::Answered(RequestUserInputResponse {
            answers: BTreeMap::from([(
                "choice".into(),
                UserInputAnswer {
                    value: self.answer.clone(),
                },
            )]),
        }))
    }
}

fn elicitation(request_id: i64) -> McpElicitation {
    McpElicitation {
        request_id: McpRequestId::Number(request_id),
        params: serde_json::from_value::<ElicitRequestParams>(serde_json::json!({
            "mode": "form",
            "message": "Choose one",
            "requestedSchema": {
                "type": "object",
                "properties": {
                    "choice": {"type": "string", "enum": ["left", "right"]}
                },
                "required": ["choice"]
            }
        }))
        .unwrap(),
    }
}

#[test]
fn concurrent_mcp_calls_keep_elicitation_bound_to_their_own_tool_context() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let updates = McpCatalogUpdates::default();
        let host = updates.client_host();
        let left = Arc::new(TestInteractions {
            answer: "left".into(),
            requests: Mutex::new(Vec::new()),
        });
        let right = Arc::new(TestInteractions {
            answer: "right".into(),
            requests: Mutex::new(Vec::new()),
        });
        let left_port: Arc<dyn ToolInteractionService> = left.clone();
        let right_port: Arc<dyn ToolInteractionService> = right.clone();
        let (left_result, right_result) = tokio::join!(
            with_active_tool_interactions(left_port, async {
                host.handle_elicitation(elicitation(1)).await.unwrap()
            }),
            with_active_tool_interactions(right_port, async {
                host.handle_elicitation(elicitation(2)).await.unwrap()
            })
        );

        assert_eq!(left_result.action, ElicitationAction::Accept);
        assert_eq!(
            left_result.content,
            Some(serde_json::json!({"choice": "left"}))
        );
        assert_eq!(right_result.action, ElicitationAction::Accept);
        assert_eq!(
            right_result.content,
            Some(serde_json::json!({"choice": "right"}))
        );
        assert_eq!(left.requests.lock().unwrap().len(), 1);
        assert_eq!(right.requests.lock().unwrap().len(), 1);
    });
}

#[derive(Default)]
struct CatalogLifecycle(Mutex<usize>);
impl extension_api::McpLifecycleContributor for CatalogLifecycle {
    fn catalog_changed(&self, event: &extension_api::McpLifecycle) {
        if matches!(event, extension_api::McpLifecycle::ToolsChanged) {
            *self.0.lock().unwrap() += 1;
        }
    }
}
