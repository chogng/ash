use crate::tests::call;
use crate::tests::initialize;
use crate::tests::server;

#[test]
fn context_read_routes_initial_and_thread_inspections_and_checks_session_membership() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let read = call(
        &server,
        &mut connection,
        serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "context/read", "params": { "scope": { "type": "environment" } } }),
    );
    assert!(read.get("error").is_none(), "{read}");
    let inspected: ash_protocol::ModelContextInspection =
        serde_json::from_value(read["result"]["context"].clone()).unwrap();
    assert!(inspected.estimated_tokens > 0);
    assert_eq!(inspected.categories.len(), 5);
    assert_eq!(inspected.latest_request, None);
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
            serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": "context/read", "params": { "scope": { "type": "thread", "sessionId": session, "threadId": thread_id } } }),
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
    let before = server.threads.read_thread(&thread_id).unwrap();
    let read = call(
        &server,
        &mut connection,
        serde_json::json!({ "jsonrpc": "2.0", "id": 5, "method": "context/read", "params": { "scope": { "type": "thread", "sessionId": session_id, "threadId": thread_id } } }),
    );
    assert!(read.get("error").is_none(), "{read}");
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
