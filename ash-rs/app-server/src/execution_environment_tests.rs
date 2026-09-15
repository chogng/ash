use super::*;

struct EnvironmentModel {
    calls: AtomicUsize,
    arguments: serde_json::Value,
}
impl ModelService for EnvironmentModel {
    fn invoke(
        &self,
        _: ash_core::ModelSelection<'_>,
        _: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        let output = if self.calls.fetch_add(1, Ordering::Relaxed) == 0 {
            vec![ResponseItem::ToolCall(ToolCall {
                id: ash_protocol::ToolCallId::new("remote-write").unwrap(),
                name: ash_protocol::ToolName::new("environment").unwrap(),
                arguments: self.arguments.clone(),
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
    let items = run_environment_turn(
        remote,
        serde_json::json!({"environment":"worker", "operation":{"type":"write","path":"result.txt","content":"approved remote write","expected_revision":null}}),
        || {
            assert!(
                !root.path().join("result.txt").exists(),
                "prepare must not write before approval"
            );
        },
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("result.txt")).unwrap(),
        "approved remote write"
    );
    assert!(items.iter().any(|item| matches!(item,
        ash_protocol::ThreadItem::ToolResult { text, is_error: false, .. } if text.contains("file written")
    )));
}

fn run_environment_turn(
    remote: exec_server::ExecClient,
    arguments: serde_json::Value,
    before_approval: impl FnOnce(),
) -> Vec<ash_protocol::ThreadItem> {
    let server = server_with_model(Arc::new(EnvironmentModel {
        calls: AtomicUsize::new(0),
        arguments,
    }))
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
    before_approval();
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
    server
        .threads()
        .read_thread(&protocol_thread_id)
        .unwrap()
        .items
}

#[test]
#[cfg(unix)]
fn execution_environment_recovers_a_lost_start_response_without_reexecution() {
    recover_command_response(LostResponse::Start);
}

#[test]
#[cfg(unix)]
fn execution_environment_recovers_a_lost_read_response_without_losing_output() {
    recover_command_response(LostResponse::Read);
}

#[cfg(unix)]
enum LostResponse {
    Start,
    Read,
}

#[cfg(unix)]
fn recover_command_response(lost: LostResponse) {
    use exec_server_protocol::Request;
    use exec_server_protocol::Response;
    use std::io::BufRead;
    use std::io::BufReader;
    use std::io::Write;

    let root = tempfile::tempdir().unwrap();
    let environment = exec_server::LocalEnvironment::open(
        "worker".into(),
        root.path(),
        exec_server_protocol::FileAccess::ReadWrite,
        exec_server_protocol::NetworkAccess::Denied,
        Arc::new(mxc_sandbox::MxcSandbox::new(
            ash_install_context::InstallContext::current(),
        )),
    )
    .unwrap();
    let incarnation = environment.info().incarnation.clone();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let peer = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut starts = 0;
        for connection in 0..2 {
            let stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "client never reconnected");
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("accept failed: {error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut reader = BufReader::new(stream);
            loop {
                let mut line = String::new();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                let message: exec_server_protocol::Message = serde_json::from_str(&line).unwrap();
                assert_eq!(message.version, exec_server_protocol::VERSION);
                assert_eq!(message.token, "a1".repeat(32));
                if !matches!(message.request, Request::EnvironmentInfo) {
                    assert_eq!(message.incarnation.as_deref(), Some(incarnation.as_str()));
                }
                if matches!(message.request, Request::ProcessStart(_)) {
                    starts += 1;
                }
                let lose = connection == 0
                    && match lost {
                        LostResponse::Start => matches!(message.request, Request::ProcessStart(_)),
                        LostResponse::Read => matches!(message.request, Request::ProcessRead(_)),
                    };
                let response = environment.request(message.request);
                if lose {
                    break;
                }
                let complete = matches!(&response, Response::Process(snapshot) if snapshot.state != exec_server_protocol::ProcessState::Running);
                let mut bytes = serde_json::to_vec(&response).unwrap();
                bytes.push(b'\n');
                reader.get_mut().write_all(&bytes).unwrap();
                if complete {
                    return starts;
                }
            }
        }
        panic!("command did not complete");
    });
    let remote = exec_server::ExecClient::connect(
        exec_server::RemoteEndpoint::new(address, "a1".repeat(32)).unwrap(),
    )
    .unwrap();
    let items = run_environment_turn(
        remote,
        serde_json::json!({"environment":"worker", "operation":{
            "type":"command", "program":"/bin/sh", "arguments":["-c", "printf x >> count; printf ready; sleep 0.1; printf done"],
            "cwd":".", "timeout_millis":10000
        }}),
        || assert!(!root.path().join("count").exists()),
    );
    assert_eq!(peer.join().unwrap(), 1, "start must never be replayed");
    assert_eq!(std::fs::read(root.path().join("count")).unwrap(), b"x");
    assert!(items.iter().any(|item| matches!(item,
        ash_protocol::ThreadItem::ToolResult { text, is_error: false, .. } if text.contains("readydone")
    )), "{items:?}");
}
