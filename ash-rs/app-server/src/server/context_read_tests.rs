use crate::tests::call;
use crate::tests::initialize;
use crate::tests::server;
use ash_core::ToolService;

#[test]
fn context_read_routes_initial_and_thread_inspections_and_checks_session_membership() {
    let profile = tempfile::tempdir().unwrap();
    let server = server()
        .with_tool_service(
            std::sync::Arc::new(InspectionTools),
            std::sync::Arc::new(InspectionPolicy),
        )
        .with_config_store(std::sync::Arc::new(
            ash_config::ConfigStore::open(&profile.path().join("config.sqlite3")).unwrap(),
        ));
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let policy = serde_json::json!({"mode": "handoff", "bufferTokens": 16384, "stateTokens": 8192});
    let updated = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc": "2.0", "id": 21, "method": "config/update", "params": {"commandId": "handoff", "expectedRevision": 0, "context": policy}}),
    );
    assert_eq!(updated["result"]["revision"], 1, "{updated}");
    let config = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc": "2.0", "id": 22, "method": "config/read", "params": {}}),
    );
    assert_eq!(config["result"]["context"], policy);
    let read = call(
        &server,
        &mut connection,
        serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "context/read", "params": { "detail": "usage", "scope": { "type": "environment" } } }),
    );
    assert!(read.get("error").is_none(), "{read}");
    assert_eq!(read["result"]["context"]["compactionPolicy"], policy);
    let inspected: ash_protocol::ModelContextInspection =
        serde_json::from_value(read["result"]["context"].clone()).unwrap();
    assert!(inspected.estimated_tokens > 0);
    assert_eq!(inspected.categories.len(), 5);
    assert_eq!(inspected.latest_request, None);
    assert_eq!(read["result"]["toolDefinitions"], serde_json::json!([]));
    let diagnostics = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc": "2.0", "id": 20, "method": "context/read", "params": {"detail": "diagnostics", "scope": {"type": "environment"}}}),
    );
    assert!(diagnostics.get("error").is_none(), "{diagnostics}");
    assert_eq!(diagnostics["result"]["context"], read["result"]["context"]);
    let definitions: Vec<ash_app_server_protocol::protocol::model::ContextToolDefinition> =
        serde_json::from_value(diagnostics["result"]["toolDefinitions"].clone()).unwrap();
    let sources = &inspected
        .categories
        .iter()
        .find(|category| category.category == ash_protocol::ModelContextCategory::SystemTools)
        .unwrap()
        .sources;
    assert_eq!(definitions.len(), 1);
    assert_eq!(definitions.len(), sources.len());
    assert_eq!(definitions[0].description, "Read a workspace file");
    assert_eq!(
        definitions[0].parameters,
        InspectionTools.definitions()[0].parameters
    );
    assert!(definitions[0].strict);
    for definition in &definitions {
        assert_eq!(
            definition.tokens,
            sources
                .iter()
                .find(|source| source.name == definition.name)
                .unwrap()
                .tokens
        );
        assert!(definition.parameters.is_object());
    }
    assert!(server.threads.list_threads().unwrap().is_empty());
    let thread_id = ash_protocol::ThreadId::new("context-thread").unwrap();
    let session_id = ash_protocol::SessionId::new("context-session").unwrap();
    server
        .threads
        .create_thread(ash_core::CreateThreadRequest {
            execution_target: None,
            agent_id: ash_protocol::AgentId::new("agent").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            title: "context".into(),
        })
        .unwrap();
    let before = server.threads.read_thread(&thread_id).unwrap();
    for (id, session, succeeds) in [
        (3, session_id.to_string(), true),
        (4, "other-session".into(), false),
    ] {
        let read = call(
            &server,
            &mut connection,
            serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": "context/read", "params": { "detail": "usage", "scope": { "type": "thread", "sessionId": session, "threadId": thread_id } } }),
        );
        assert_eq!(read.get("error").is_none(), succeeds, "{read}");
    }
    let after = server.threads.read_thread(&thread_id).unwrap();
    assert_eq!(before.sequence, after.sequence);
    assert!(after.turns.is_empty());
    server
        .threads
        .start_turn(
            &thread_id,
            ash_core::StartTurnRequest {
                context_policy: serde_json::from_value(policy.clone()).unwrap(),
                command_id: ash_protocol::CommandId::new("context-turn").unwrap(),
                expected_sequence: core_api::SequenceExpectation::Any,
                model: None,
                reasoning_effort: None,
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                mode: Default::default(),
                instructions: ash_protocol::TurnInstructions::new(
                    "test",
                    "context-frozen",
                    "v1",
                    "frozen context rule",
                )
                .unwrap(),
                policy_revision: "test-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::Manual,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![ash_protocol::UserInput::Text {
                    text: "hello".into(),
                }],
            },
        )
        .unwrap();
    let reset = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc": "2.0", "id": 23, "method": "config/update", "params": {"commandId": "summary", "expectedRevision": 1, "context": null}}),
    );
    assert_eq!(reset["result"]["revision"], 2, "{reset}");
    let read = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc": "2.0", "id": 24, "method": "context/read", "params": {"detail": "usage", "scope": {"type": "environment"}}}),
    );
    assert_eq!(
        read["result"]["context"]["compactionPolicy"]["mode"],
        "summary"
    );
    let before = server.threads.read_thread(&thread_id).unwrap();
    let read = call(
        &server,
        &mut connection,
        serde_json::json!({ "jsonrpc": "2.0", "id": 5, "method": "context/read", "params": { "detail": "usage", "scope": { "type": "thread", "sessionId": session_id, "threadId": thread_id } } }),
    );
    assert!(read.get("error").is_none(), "{read}");
    assert_eq!(read["result"]["context"]["compactionPolicy"], policy);
    let inspected: ash_protocol::ModelContextInspection =
        serde_json::from_value(read["result"]["context"].clone()).unwrap();
    assert!(
        inspected.categories[0]
            .sources
            .iter()
            .any(|source| source.name == "context-frozen")
    );
    assert!(inspected.categories[4].tokens > 0);
    assert_eq!(
        before.sequence,
        server.threads.read_thread(&thread_id).unwrap().sequence
    );
}

struct InspectionTools;
impl ToolService for InspectionTools {
    fn definitions(&self) -> Vec<ash_protocol::ToolDefinition> {
        vec![ash_protocol::ToolDefinition {
            name: ash_protocol::ToolName::new("read_file").unwrap(),
            description: "Read a workspace file".into(),
            parameters: serde_json::json!({"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}),
            strict: true,
        }]
    }
    fn prepare(
        &self,
        _: &ash_protocol::ToolCall,
    ) -> Result<ash_action_policy::ActionReviewRequest, core_api::CoreError> {
        panic!("inspection must not prepare an action")
    }
    fn execute(
        &self,
        _: &ash_protocol::ToolCall,
        _: &ash_core::ToolAuthorization,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<ash_protocol::ToolExecutionOutput, core_api::CoreError> {
        panic!("inspection must not execute a tool")
    }
}
struct InspectionPolicy;
impl core_api::ActionPolicyService for InspectionPolicy {
    fn revision(&self) -> String {
        "inspection".into()
    }
    fn decide(
        &self,
        _: &ash_action_policy::ActionReviewRequest,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<ash_action_policy::ExecutionDecision, core_api::CoreError> {
        panic!("inspection must not request action authorization")
    }
}
