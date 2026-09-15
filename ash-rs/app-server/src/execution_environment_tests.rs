use super::*;

struct EnvironmentModel(AtomicUsize);
impl ModelService for EnvironmentModel {
    fn invoke(
        &self,
        _: ash_core::ModelSelection<'_>,
        _: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        let output = if self.0.fetch_add(1, Ordering::Relaxed) == 0 {
            vec![ResponseItem::ToolCall(ToolCall {
                id: ash_protocol::ToolCallId::new("remote-write").unwrap(),
                name: ash_protocol::ToolName::new("environment").unwrap(),
                arguments: serde_json::json!({"environment":"worker", "operation":{"type":"write","path":"result.txt","content":"approved remote write","expected_revision":null}}),
            })]
        } else {
            vec![ResponseItem::Text("done".into())]
        };
        let stop_reason = if matches!(output[0], ResponseItem::ToolCall(_)) {
            StopReason::ToolUse
        } else {
            StopReason::Completed
        };
        Ok(ModelResponse {
            output,
            usage: None,
            billing: None,
            stop_reason,
        })
    }
}

#[test]
fn execution_environment_turn_waits_for_approval_and_persists_remote_result() {
    let root = tempfile::tempdir().unwrap();
    let environment = Arc::new(
        exec_server::LocalEnvironment::open(
            "worker".into(),
            root.path(),
            exec_server_protocol::FileAccess::ReadWrite,
            exec_server_protocol::NetworkAccess::Denied,
            Arc::new(mxc_sandbox::MxcSandbox::new(
                ash_install_context::InstallContext::current(),
            )),
        )
        .unwrap(),
    );
    let token = "a1".repeat(32);
    let listener =
        exec_server::ExecListener::bind("127.0.0.1:0".parse().unwrap(), &token, environment)
            .unwrap();
    let remote = exec_server::ExecClient::connect(
        exec_server::RemoteEndpoint::new(listener.address(), token).unwrap(),
    )
    .unwrap();
    let server = server_with_model(Arc::new(EnvironmentModel(AtomicUsize::new(0))))
        .with_execution_environments(vec![exec_server::ExecutionEnvironment::Remote(remote)])
        .unwrap();
    let mut connection = server.connection();
    initialize_with_capabilities(
        &server,
        &mut connection,
        serde_json::json!({"agentInteractions":{"version":1,"kinds":["approval"]}}),
    );
    let session = create_session(&server, &mut connection, 2, "execution-session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(
        &server,
        &mut connection,
        3,
        "execution-thread",
        session_id,
        1,
    );
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    let started = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":4, "method":"session/request", "params":{
                "commandId":"execution-turn", "sessionId":session_id,
                "request":{"type":"startTurn","expectedSequence":1,"threadId":thread_id,"input":[{"type":"text","text":"write the result on worker"}]}
            }
        }),
    );
    let turn_id = started["result"]["value"]["turnId"]
        .as_str()
        .expect("turn starts");
    let protocol_thread_id = ash_protocol::ThreadId::new(thread_id).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let (sequence, request_id) = loop {
        let snapshot = server.threads().read_thread(&protocol_thread_id).unwrap();
        if let Some(interaction) = snapshot.turns[0].pending_interaction.as_ref() {
            break (snapshot.sequence, interaction.request_id.to_string());
        }
        assert!(
            Instant::now() < deadline,
            "approval never appeared: {snapshot:?}"
        );
        thread::sleep(Duration::from_millis(10));
    };
    assert!(
        !root.path().join("result.txt").exists(),
        "prepare must not write before approval"
    );
    let resolved = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":5,"method":"session/request","params":{
                "commandId":"approve-execution","sessionId":session_id,
                "request":{"type":"resolveInteraction","expectedSequence":sequence,"threadId":thread_id,"turnId":turn_id,"requestId":request_id,"response":{"type":"approval","response":{"decision":"approveOnce"}}}
            }
        }),
    );
    assert!(resolved.get("error").is_none(), "{resolved}");
    wait_for_latest_turn(&server, thread_id, TurnStatus::Completed);
    assert_eq!(
        std::fs::read_to_string(root.path().join("result.txt")).unwrap(),
        "approved remote write"
    );
    let snapshot = server.threads().read_thread(&protocol_thread_id).unwrap();
    assert!(snapshot.items.iter().any(|item| matches!(item,
        ash_protocol::ThreadItem::ToolResult { text, is_error: false, .. } if text.contains("file written")
    )));
}
