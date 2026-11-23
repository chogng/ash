use super::*;
use agent_message_board::AccessToken;
use agent_message_board::BoardBackend;
use agent_message_board::BoardNotification;
use agent_message_board::RemoteUnread;
use agent_message_board_client::NotificationWatch;
use ash_async_utils::CancellationToken;
use ash_core::CreateThreadRequest;
use ash_core::InMemoryThreadStore;
use ash_core::StartTurnRequest;
use ash_extension_api::ExtensionScope;
use ash_extension_api::TurnInputContext;
use ash_http_client::HttpBodySink;
use ash_http_client::HttpClientError;
use ash_http_client::HttpRequest;
use ash_http_client::HttpResponse;
use core_api::SequenceExpectation;
use serde_json::json;
use std::collections::VecDeque;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;

fn start(threads: &ThreadController, root: &ThreadId, key: &str) -> TurnId {
    threads
        .start_turn(
            root,
            StartTurnRequest {
                context_policy: Default::default(),
                mode: Default::default(),
                command_id: ash_protocol::CommandId::new(key).unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                reasoning_effort: None,
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                policy_revision: "board-test".into(),
                approval_mode: ash_protocol::ApprovalMode::Manual,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: vec![],
                input: vec![ash_protocol::UserInput::Text {
                    text: "share evidence".into(),
                }],
            },
        )
        .unwrap()
        .turn_id
}
#[test]
fn only_the_exact_active_turn_can_install_a_receiver() {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let registry = Arc::new(ExtensionRegistryBuilder::new().build());
    threads.install_extensions(registry.clone()).unwrap();
    let host = ThreadHost {
        threads: Arc::downgrade(&threads),
    };
    let session = SessionId::new("session").unwrap();
    let root = ThreadId::new("root").unwrap();
    threads
        .create_thread(CreateThreadRequest {
            execution_target: None,
            agent_id: ash_protocol::AgentId::new("agent").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: session.clone(),
            thread_id: root.clone(),
            title: "root".into(),
        })
        .unwrap();
    let current = start(&threads, &root, "current");
    let accepted = |session: &SessionId, turn: &TurnId| {
        let mut accepted = false;
        host.with_active_turn(&root, session, turn, &mut || accepted = true)
            .unwrap();
        accepted
    };
    assert!(accepted(&session, &current));
    assert!(!accepted(
        &SessionId::new("foreign-session").unwrap(),
        &current
    ));
    threads
        .complete_turn(&root, &current, "done".into())
        .unwrap();
    assert!(!accepted(&session, &current));
    let next = start(&threads, &root, "next");
    assert!(!accepted(&session, &current));
    assert!(accepted(&session, &next));
    threads
        .interrupt_turn(
            &root,
            core_api::InterruptTurnRequest {
                command_id: ash_protocol::CommandId::new("stop").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                turn_id: next.clone(),
            },
        )
        .unwrap();
    assert_eq!(threads.read_thread(&root).unwrap().turns.len(), 2);
}

#[test]
fn remote_board_tools_use_host_identity_and_reject_calls_after_turn_completion() {
    use ash_async_utils::CancellationSource;
    use ash_tools::ToolExecutionOutcome;
    use ash_tools::ToolOutputStatus;

    // Canned external responses exercise the real tool-to-client path without
    // keeping a message-board service implementation in the test suite.
    struct Transport {
        requests: Mutex<Vec<HttpRequest>>,
        responses: Mutex<VecDeque<serde_json::Value>>,
    }
    impl HttpClient for Transport {
        fn execute(
            &self,
            request: &HttpRequest,
        ) -> std::result::Result<HttpResponse, HttpClientError> {
            self.requests.lock().unwrap().push(request.clone());
            let response = self.responses.lock().unwrap().pop_front().unwrap();
            Ok(HttpResponse::new(
                200,
                vec![],
                serde_json::to_vec(&response).unwrap(),
            ))
        }
    }
    let host_token = "test-board-host-credential-at-least-32";
    let tree_token = "test-board-tree-credential-at-least-32";
    let post = json!({"id":42,"text":"evidence"});
    let http = Arc::new(Transport {
        requests: Mutex::new(vec![]),
        responses: Mutex::new(VecDeque::from([
            json!(tree_token),
            json!({"channel":"work"}),
            json!(tree_token),
            post.clone(),
            post.clone(),
            json!({"count":0,"through":0,"notices":[]}),
            json!(null),
        ])),
    });
    let remote = Arc::new(
        RemoteMessageBoard::new(
            http.clone(),
            "https://boards.test",
            agent_message_board_client::AccessToken::new(host_token.into()).unwrap(),
        )
        .unwrap(),
    );
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let mut builder = ExtensionRegistryBuilder::new();
    let host = Arc::new(ThreadHost {
        threads: Arc::downgrade(&threads),
    });
    agent_message_board::install(&mut builder, host, BoardInput::Remote(remote.clone()));
    let registry = Arc::new(builder.build());
    threads.install_extensions(registry.clone()).unwrap();
    let session = SessionId::new("tool-session").unwrap();
    let root = ThreadId::new("root").unwrap();
    threads
        .create_thread(CreateThreadRequest {
            execution_target: None,
            agent_id: ash_protocol::AgentId::new("agent").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: session.clone(),
            thread_id: root.clone(),
            title: "root".into(),
        })
        .unwrap();
    let turn = start(&threads, &root, "tool-turn");
    let write = registry
        .contribute_capability_tools()
        .unwrap()
        .into_iter()
        .find(|tool| tool.executor().definition().name().as_str() == "board_write")
        .unwrap();
    let call = |operation: &str, arguments| {
        let definition = write.executor().definition();
        let invocation = ash_tools::ToolInvocation::new(
            ash_tools::ToolOperationId::new(operation).unwrap(),
            ash_protocol::ToolCallId::new(operation).unwrap(),
            turn.clone(),
            ash_tools::ToolBinding::new(
                ash_tools::ToolRegistryGeneration::new(1),
                ash_tools::ToolBindingId::new("board_write").unwrap(),
                definition.name().clone(),
                definition.digest(),
                ash_tools::ToolRuntimeKey::new("board_write").unwrap(),
            ),
            ash_tools::ToolPayload::FunctionArguments(arguments),
            ash_tools::ToolExecutionContext::new(
                ash_tools::EnvId::new("test").unwrap(),
                CancellationSource::new().token(),
                ash_tools::ToolRuntimeAuthority::Unrestricted,
            )
            .with_session_id(session.clone())
            .with_thread_id(root.clone()),
        );
        let ToolExecutionOutcome::Returned(output) =
            pollster::block_on(write.executor().execute(invocation))
        else {
            panic!("tool did not execute")
        };
        output.status()
    };
    assert_eq!(
        call(
            "create",
            json!({"action":"create_channel","channel":"work"})
        ),
        ToolOutputStatus::Success
    );
    assert_eq!(
        call(
            "post",
            json!({"action":"post","channel":"work","text":"evidence"})
        ),
        ToolOutputStatus::Success
    );
    let scope = Scope {
        session: session.clone(),
        root: root.clone(),
    };
    let cancellation = CancellationSource::new();
    assert_eq!(
        remote
            .read(
                &scope,
                &root,
                &agent_message_board::ReadRequest::Post {
                    id: 42,
                    offset: 0,
                    chars: None,
                },
                &cancellation.token()
            )
            .unwrap(),
        post
    );
    assert_eq!(
        remote
            .unread(&scope, &root, &cancellation.token())
            .unwrap()
            .count,
        0
    );
    threads.complete_turn(&root, &turn, "done".into()).unwrap();
    assert_eq!(
        call(
            "late",
            json!({"action":"post","channel":"work","text":"late"})
        ),
        ToolOutputStatus::Error
    );
    assert_eq!(http.requests.lock().unwrap().len(), 6);
    remote.delete_session(&session).unwrap();
    assert!(remote.unread(&scope, &root, &cancellation.token()).is_err());
    let requests = http.requests.lock().unwrap();
    assert_eq!(requests.len(), 7);
    assert!(http.responses.lock().unwrap().is_empty());
    for (index, request) in requests.iter().enumerate() {
        let (suffix, token) = match index {
            0 | 2 => ("/members", host_token),
            6 => ("/delete-session", host_token),
            _ => ("/call", tree_token),
        };
        assert_eq!(
            request.url(),
            format!("https://boards.test/v1/agent-message-board{suffix}")
        );
        assert!(request.rejects_redirects());
        assert!(
            request
                .headers()
                .iter()
                .any(|header| header.name() == "Authorization"
                    && header.value() == format!("Bearer {token}"))
        );
        let body: serde_json::Value = serde_json::from_slice(request.body()).unwrap();
        if index == 6 {
            assert_eq!(body, json!(session));
        } else {
            assert_eq!(body["scope"], json!({"session":session,"root":root}));
            if index == 0 || index == 2 {
                assert_eq!(body["members"], json!([root]));
            } else {
                assert_eq!(body["caller"], json!(root));
            }
        }
    }
    let written: serde_json::Value = serde_json::from_slice(requests[3].body()).unwrap();
    let operation: Vec<String> = serde_json::from_str(
        written["operation"]["params"]["operation_id"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(operation, vec![turn.as_str(), "post"]);
    assert_eq!(
        written["operation"]["params"]["request"]["text"],
        "evidence"
    );
}

#[test]
fn a_recovered_turn_receives_remote_unread_updates_from_its_background_observer() {
    struct Transport {
        delivered: mpsc::Sender<NotificationWatch>,
        has_post: AtomicBool,
    }

    fn preview() -> serde_json::Value {
        json!({"id":1,"topic":1,"channel":"work","author":"sender","created_at":1,"preview":"evidence","total_chars":8,"replies":0})
    }

    impl HttpClient for Transport {
        fn execute(
            &self,
            request: &HttpRequest,
        ) -> std::result::Result<HttpResponse, HttpClientError> {
            let body = if request.url().ends_with("/members") {
                json!("registered-board-tree-credential-32")
            } else {
                assert!(request.url().ends_with("/call"));
                if self.has_post.load(Ordering::Relaxed) {
                    json!({"count":1,"through":1,"notices":[preview()]})
                } else {
                    json!({"count":0,"through":0,"notices":[]})
                }
            };
            Ok(HttpResponse::new(
                200,
                vec![],
                serde_json::to_vec(&body).unwrap(),
            ))
        }

        fn execute_streaming_with_cancellation(
            &self,
            request: &HttpRequest,
            _: &CancellationToken,
            sink: &mut dyn HttpBodySink,
        ) -> std::result::Result<HttpResponse, HttpClientError> {
            let watch: NotificationWatch = serde_json::from_slice(request.body()).unwrap();
            let notice = BoardNotification {
                scope: watch.scope.clone(),
                recipient: watch.caller.clone(),
                turn_id: watch.turn_id.clone(),
                post: preview(),
            };
            let frame = format!(
                "event: ready\ndata: {{}}\n\nevent: notification\ndata: {}\n\n",
                serde_json::to_string(&notice).unwrap()
            );
            self.has_post.store(true, Ordering::Relaxed);
            sink.emit(frame.as_bytes())?;
            let _ = self.delivered.send(watch);
            Ok(HttpResponse::new(200, vec![], vec![]))
        }
    }

    let (delivered, notices) = mpsc::channel();
    let http: Arc<dyn HttpClient> = Arc::new(Transport {
        delivered,
        has_post: AtomicBool::new(false),
    });
    let remote = RemoteMessageBoard::new(
        http.clone(),
        "https://boards.test",
        AccessToken::new("host-administrator-credential-32-bytes".into()).unwrap(),
    )
    .unwrap();
    let board = MessageBoard {
        backend: Backend::Remote {
            client: Arc::new(remote),
            location: RemoteBoardLocation {
                endpoint: "https://boards.test".into(),
                credential_env: "ASH_TEST_UNUSED_BOARD_CREDENTIAL".into(),
            },
        },
        store: Arc::new(Store::in_memory().unwrap()),
        cleanup: Arc::default(),
        http,
    };
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let session = SessionId::new("session").unwrap();
    let root = ThreadId::new("root").unwrap();
    threads
        .create_thread(CreateThreadRequest {
            execution_target: None,
            agent_id: ash_protocol::AgentId::new("agent").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: session.clone(),
            thread_id: root.clone(),
            title: "root".into(),
        })
        .unwrap();
    let turn = start(&threads, &root, "remote-notice");
    let mut builder = ExtensionRegistryBuilder::new();
    board.install(&mut builder, &threads);
    let registry = Arc::new(builder.build());
    threads.install_extensions(registry.clone()).unwrap();
    let context = || TurnInputContext::for_session(&session, &root, &turn, &[]);
    registry.contribute_turn_input(context()).unwrap();
    let watch = notices.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(watch.turn_id, turn);
    assert_eq!(watch.scope.session, session);
    assert_eq!(watch.scope.root, root);
    let fragments = registry.contribute_turn_input(context()).unwrap();
    assert_eq!(fragments.len(), 2);
    assert!(fragments[1].body().contains("evidence"));
    let scope = ExtensionScope::Turn(session.clone(), root.clone(), turn.clone());
    threads.complete_turn(&root, &turn, "done".into()).unwrap();
    assert!(
        registry
            .contribute_turn_input(context())
            .unwrap()
            .is_empty()
    );
    assert!(
        registry
            .state()
            .get::<RemoteUnread>(&scope)
            .unwrap()
            .is_none()
    );
}
