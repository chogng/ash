use std::collections::HashMap;
use std::io::Read;
use std::io::Write;
use std::time::Duration;
use std::time::Instant;

use ash_debug_adapter::DebugAdapterConnection;
use ash_debug_adapter::DebugAdapterRead;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use serde_json::json;

use super::DebugManager;
use super::DebugMessageDirection;
use super::DebugResponse;

pub(super) fn manager() -> DebugManager {
    let authorization = |permission| {
        Grant::for_environment(
            Dir::open_local(std::env::temp_dir()).unwrap(),
            GrantSource::HostConfiguration,
            Permissions::new([permission]),
        )
        .authorize(permission)
        .unwrap()
    };
    DebugManager::new(
        authorization(Permission::LoadConfig),
        authorization(Permission::ExecuteCommands),
        HashMap::new(),
    )
    .unwrap()
}

#[test]
fn real_tcp_adapter_completes_requests_without_a_view_reader_and_closes_the_socket() {
    let manager = manager();
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let peer = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            stream.read_exact(&mut byte).unwrap();
            header.push(byte[0]);
        }
        let length = std::str::from_utf8(&header)
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        let mut body = vec![0; length];
        stream.read_exact(&mut body).unwrap();
        let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(request["command"], "evaluate");
        let response = json!({"seq":0,"type":"response","request_seq":request["seq"],"command":"evaluate","success":true,"body":{"result":"42","variablesReference":0}}).to_string();
        write!(
            stream,
            "Content-Length: {}\r\n\r\n{}",
            response.len(),
            response
        )
        .unwrap();
        let mut byte = [0];
        assert_eq!(stream.read(&mut byte).unwrap(), 0);
    });
    let id = manager
        .connect(DebugAdapterConnection::Server { port, host: None })
        .unwrap();
    assert!(
        manager
            .input(
                &id,
                DebugAdapterRead {
                    messages: vec![],
                    next_sequence: 0,
                    output_gap: false,
                    stderr: String::new(),
                    exited: false,
                    exit_code: None,
                    protocol_error: None
                }
            )
            .is_err()
    );
    let request = manager
        .request(
            &id,
            "evaluate",
            Some(json!({"expression":"answer","frameId":7})),
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match manager.response(&id, request).unwrap() {
            DebugResponse::Pending => {
                assert!(Instant::now() < deadline);
                std::thread::yield_now();
            }
            DebugResponse::Complete(response) => {
                assert_eq!(response["body"]["result"], "42");
                break;
            }
            DebugResponse::Failed(message) => panic!("{message}"),
        }
    }
    let read = manager.read(&id, 0, 128).unwrap();
    assert_eq!(read.messages.len(), 2);
    assert_eq!(read.messages[0].direction, DebugMessageDirection::Outgoing);
    assert_eq!(read.messages[1].direction, DebugMessageDirection::Incoming);
    manager.close(&id).unwrap();
    manager.close(&id).unwrap();
    assert!(manager.request(&id, "evaluate", None).is_err());
    peer.join().unwrap();
}

#[test]
fn inline_transport_uses_the_same_pairing_and_cannot_impersonate_an_adapter_process() {
    let manager = manager();
    let id = manager.open_client_transport().unwrap();
    let request = manager.request(&id, "custom", Some(json!(null))).unwrap();
    let read = manager.read(&id, 0, 128).unwrap();
    assert_eq!(read.messages[0].message["arguments"], json!(null));
    manager.input(&id, DebugAdapterRead {
        messages: vec![ash_debug_adapter::DebugAdapterMessage { sequence: 0, message: json!({"seq":0,"type":"response","request_seq":request,"command":"custom","success":true}) }],
        next_sequence: 1, output_gap: false, stderr: String::new(), exited: false, exit_code: None, protocol_error: None,
    }).unwrap();
    let DebugResponse::Complete(response) = manager.response(&id, request).unwrap() else {
        panic!()
    };
    assert!(response.get("body").is_none());
    manager.close(&id).unwrap();
}

#[test]
fn observation_pages_report_gaps_and_never_advance_past_the_returned_page() {
    let manager = manager();
    let id = manager.open_client_transport().unwrap();
    for seq in 0..super::MAX_OBSERVATIONS as u64 + 88 {
        manager.input(&id, DebugAdapterRead {
            messages: vec![ash_debug_adapter::DebugAdapterMessage { sequence: seq, message: json!({"seq":seq,"type":"event","event":"output","body":{"output":"line"}}) }],
            next_sequence: seq + 1, output_gap: false, stderr: String::new(), exited: false, exit_code: None, protocol_error: None,
        }).unwrap();
    }
    let read = manager.read(&id, 0, 20).unwrap();
    assert!(read.output_gap);
    assert_eq!(read.messages.len(), 20);
    assert_eq!(read.next_sequence, 108);
    assert!(
        !manager
            .read(&id, read.next_sequence, 20)
            .unwrap()
            .output_gap
    );
    manager.terminate_all();
    assert!(manager.read(&id, 0, 1).is_err());
}

#[test]
fn self_hosting_connections_fit_the_bounded_budget_and_release_their_slots() {
    let manager = manager();
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut sessions = Vec::new();
    let mut peers = Vec::new();
    for _ in 0..16 {
        sessions.push(
            manager
                .connect(DebugAdapterConnection::Server { port, host: None })
                .unwrap(),
        );
        peers.push(listener.accept().unwrap().0);
    }
    assert!(
        manager
            .connect(DebugAdapterConnection::Server { port, host: None })
            .is_err()
    );
    manager.close(&sessions.pop().unwrap()).unwrap();
    let replacement = manager
        .connect(DebugAdapterConnection::Server { port, host: None })
        .unwrap();
    peers.push(listener.accept().unwrap().0);
    manager.terminate_all();
    assert!(manager.read(&replacement, 0, 1).is_err());
}

#[test]
fn source_catalog_observations_remain_available_through_a_startup_stop() {
    let manager = manager();
    let id = manager.open_client_transport().unwrap();
    for sequence in 0..5001 {
        let message = if sequence == 5000 {
            json!({"seq":sequence,"type":"event","event":"stopped","body":{"threadId":1,"reason":"breakpoint"}})
        } else {
            json!({"seq":sequence,"type":"event","event":"loadedSource","body":{"reason":"new","source":{"path":format!("/workspace/{sequence}.ts")}}})
        };
        manager
            .input(
                &id,
                DebugAdapterRead {
                    messages: vec![ash_debug_adapter::DebugAdapterMessage { sequence, message }],
                    next_sequence: sequence + 1,
                    output_gap: false,
                    stderr: String::new(),
                    exited: false,
                    exit_code: None,
                    protocol_error: None,
                },
            )
            .unwrap();
    }
    let mut cursor = 0;
    loop {
        let page = manager.read(&id, cursor, 128).unwrap();
        assert!(!page.output_gap);
        if page.messages.is_empty() {
            break;
        }
        cursor = page.next_sequence;
    }
    assert_eq!(cursor, 5001);
    manager.close(&id).unwrap();
}

#[test]
fn malformed_transport_input_fails_every_waiter_without_replaying_a_command() {
    let manager = manager();
    let id = manager.open_client_transport().unwrap();
    let first = manager.request(&id, "launch", None).unwrap();
    let second = manager.request(&id, "evaluate", None).unwrap();
    manager.input(&id, DebugAdapterRead {
        messages: vec![ash_debug_adapter::DebugAdapterMessage { sequence: 0, message: json!({"seq":0,"type":"response","request_seq":first,"command":"wrong","success":true}) }],
        next_sequence: 1, output_gap: false, stderr: String::new(), exited: false, exit_code: None, protocol_error: None,
    }).unwrap();
    for request in [first, second] {
        assert!(matches!(
            manager.response(&id, request).unwrap(),
            DebugResponse::Failed(_)
        ));
    }
    assert!(manager.request(&id, "launch", None).is_err());
    let read = manager.read(&id, 0, 128).unwrap();
    assert!(read.protocol_error.is_some());
    assert_eq!(read.messages.len(), 2);
}

#[test]
fn revoking_a_directory_grant_blocks_client_transport_calls_but_allows_cleanup() {
    let directory = Dir::open_local(std::env::temp_dir()).unwrap();
    let configuration = Grant::for_environment(
        directory.clone(),
        GrantSource::HostConfiguration,
        Permissions::new([Permission::LoadConfig]),
    );
    let execution = Grant::for_environment(
        directory,
        GrantSource::HostConfiguration,
        Permissions::new([Permission::ExecuteCommands]),
    );
    let manager = DebugManager::new(
        configuration.authorize(Permission::LoadConfig).unwrap(),
        execution.authorize(Permission::ExecuteCommands).unwrap(),
        HashMap::new(),
    )
    .unwrap();
    let id = manager.open_client_transport().unwrap();
    execution.revoke();
    assert!(manager.request(&id, "launch", None).is_err());
    assert!(manager.read(&id, 0, 1).is_err());
    assert!(manager.open_client_transport().is_err());
    manager.close(&id).unwrap();
}

fn feed(manager: &DebugManager, id: &super::DebugSessionId, messages: Vec<serde_json::Value>) {
    manager
        .input(
            id,
            DebugAdapterRead {
                messages: messages
                    .into_iter()
                    .map(|message| ash_debug_adapter::DebugAdapterMessage {
                        sequence: 0,
                        message,
                    })
                    .collect(),
                next_sequence: 0,
                output_gap: false,
                stderr: String::new(),
                exited: false,
                exit_code: None,
                protocol_error: None,
            },
        )
        .unwrap();
}

fn begin(manager: &DebugManager, id: &super::DebugSessionId) {
    manager
        .initialize(
            id,
            super::DebugInitialize {
                adapter_id: "test".into(),
                request: super::DebugLaunchRequest::Launch,
                arguments: serde_json::Map::from_iter([("program".into(), json!("example"))]),
                run_in_terminal: true,
                start_debugging: false,
            },
        )
        .unwrap();
}

fn reply_message(request: u64, command: &str, body: serde_json::Value) -> serde_json::Value {
    json!({"seq":0,"type":"response","request_seq":request,"command":command,"success":true,"body":body})
}

#[test]
fn initialization_gates_configuration_and_preserves_a_stop_before_launch_completion() {
    use super::DebugExecutionState;
    use super::DebugInitializationPhase;
    let manager = manager();
    let id = manager.open_client_transport().unwrap();
    begin(&manager, &id);
    assert!(
        manager
            .initialize(
                &id,
                super::DebugInitialize {
                    adapter_id: "test".into(),
                    request: super::DebugLaunchRequest::Attach,
                    arguments: Default::default(),
                    run_in_terminal: false,
                    start_debugging: false,
                }
            )
            .is_err()
    );
    assert!(manager.configure(&id, vec![]).is_err());
    assert!(manager.request(&id, "launch", None).is_err());
    let first = manager.read(&id, 0, 128).unwrap();
    assert_eq!(first.messages.len(), 1);
    assert_eq!(
        first.messages[0].message["arguments"]["supportsRunInTerminalRequest"],
        true
    );
    // Initialized can precede the initialize reply; launch need not reply until
    // configurationDone, and a stop can precede that final launch reply.
    feed(
        &manager,
        &id,
        vec![
            json!({"seq":0,"type":"event","event":"initialized"}),
            reply_message(
                1,
                "initialize",
                json!({"supportsConfigurationDoneRequest":true,"supportsSetVariable":true,"exceptionBreakpointFilters":[{"filter":"uncaught","label":"Uncaught","default":true}]}),
            ),
        ],
    );
    assert_eq!(
        manager.read(&id, 0, 128).unwrap().session.phase,
        DebugInitializationPhase::Configuring
    );
    manager.configure(&id, None).unwrap();
    assert!(manager.configure(&id, vec![]).is_err());
    let read = manager.read(&id, 0, 128).unwrap();
    let exception = &read.messages.last().unwrap().message;
    assert_eq!(exception["command"], "setExceptionBreakpoints");
    assert_eq!(exception["arguments"]["filters"], json!(["uncaught"]));
    feed(
        &manager,
        &id,
        vec![reply_message(3, "setExceptionBreakpoints", json!({}))],
    );
    assert_eq!(
        manager
            .read(&id, 0, 128)
            .unwrap()
            .messages
            .last()
            .unwrap()
            .message["command"],
        "configurationDone"
    );
    feed(
        &manager,
        &id,
        vec![
            json!({"seq":0,"type":"event","event":"stopped","body":{"threadId":7,"reason":"breakpoint"}}),
            reply_message(4, "configurationDone", json!({})),
            reply_message(2, "launch", json!({})),
        ],
    );
    let snapshot = manager.read(&id, 0, 128).unwrap().session;
    assert_eq!(snapshot.phase, DebugInitializationPhase::Active);
    assert_eq!(snapshot.state, DebugExecutionState::Stopped);
    assert_eq!(snapshot.stopped_thread_id, Some(7));
    assert!(snapshot.capabilities.supports_set_variable);
    assert!(!snapshot.capabilities.supports_restart);
}

#[test]
fn dynamic_capabilities_merge_and_configuration_done_is_only_sent_when_negotiated() {
    use super::DebugInitializationPhase;
    let manager = manager();
    let id = manager.open_client_transport().unwrap();
    begin(&manager, &id);
    feed(
        &manager,
        &id,
        vec![
            reply_message(1, "initialize", json!({"supportsRestartRequest":true})),
            json!({"seq":0,"type":"event","event":"initialized"}),
            reply_message(2, "launch", json!({})),
            json!({"seq":0,"type":"event","event":"capabilities","body":{"capabilities":{"supportsSetVariable":true}}}),
        ],
    );
    assert!(manager.configure(&id, vec!["unsupported".into()]).is_err());
    manager.configure(&id, None).unwrap();
    feed(
        &manager,
        &id,
        vec![reply_message(3, "setExceptionBreakpoints", json!({}))],
    );
    let read = manager.read(&id, 0, 128).unwrap();
    assert_eq!(read.session.phase, DebugInitializationPhase::Active);
    assert!(read.session.capabilities.supports_restart);
    assert!(read.session.capabilities.supports_set_variable);
    assert!(
        !read
            .messages
            .iter()
            .any(|entry| entry.message["command"] == "configurationDone")
    );
    assert_eq!(
        read.messages
            .iter()
            .find(
                |entry| entry.message["command"] == "setExceptionBreakpoints"
                    && entry.message["type"] == "request"
            )
            .unwrap()
            .message["arguments"]["filters"],
        json!([])
    );
}

#[test]
fn delayed_execution_responses_and_failed_steps_do_not_overwrite_new_stops() {
    use super::DebugExecutionState;
    let manager = manager();
    let id = manager.open_client_transport().unwrap();
    feed(
        &manager,
        &id,
        vec![json!({"seq":0,"type":"event","event":"stopped","body":{"threadId":1}})],
    );
    let request = manager
        .request(&id, "next", Some(json!({"threadId":1})))
        .unwrap();
    feed(
        &manager,
        &id,
        vec![
            json!({"seq":0,"type":"event","event":"stopped","body":{"threadId":2,"reason":"step"}}),
            reply_message(request, "next", json!({})),
        ],
    );
    assert_eq!(
        manager.read(&id, 0, 128).unwrap().session.state,
        DebugExecutionState::Stopped
    );
    assert!(matches!(
        manager.response(&id, request).unwrap(),
        DebugResponse::Complete(_)
    ));
    let failed = manager.request(&id, "next", None).unwrap();
    feed(
        &manager,
        &id,
        vec![
            json!({"seq":0,"type":"response","request_seq":failed,"command":"next","success":false}),
        ],
    );
    assert_eq!(
        manager.read(&id, 0, 128).unwrap().session.state,
        DebugExecutionState::Stopped
    );
    let continued = manager.request(&id, "continue", None).unwrap();
    feed(
        &manager,
        &id,
        vec![reply_message(continued, "continue", json!({}))],
    );
    assert_eq!(
        manager.read(&id, 0, 128).unwrap().session.state,
        DebugExecutionState::Running
    );
}

#[test]
fn inspection_completion_is_invalidated_by_resume_and_invalidated_events() {
    let manager = manager();
    let id = manager.open_client_transport().unwrap();
    for event in ["continued", "invalidated"] {
        let request = manager
            .request(&id, "variables", Some(json!({"variablesReference":1})))
            .unwrap();
        feed(
            &manager,
            &id,
            vec![
                json!({"seq":0,"type":"event","event":event}),
                reply_message(request, "variables", json!({"variables":[]})),
            ],
        );
        assert!(matches!(
            manager.response(&id, request).unwrap(),
            DebugResponse::Failed(_)
        ));
    }
}

#[test]
fn launch_failure_ends_initialization_without_replaying_launch_or_configuring() {
    use super::DebugExecutionState;
    let manager = manager();
    let id = manager.open_client_transport().unwrap();
    begin(&manager, &id);
    feed(
        &manager,
        &id,
        vec![
            reply_message(1, "initialize", json!({})),
            json!({"seq":0,"type":"response","request_seq":2,"command":"launch","success":false,"message":"parent launch failed"}),
        ],
    );
    for _ in 0..3 {
        let read = manager.read(&id, 0, 128).unwrap();
        assert_eq!(read.session.state, DebugExecutionState::Error);
        assert_eq!(read.session.reason.as_deref(), Some("parent launch failed"));
        assert_eq!(
            read.messages
                .iter()
                .filter(|entry| entry.direction == DebugMessageDirection::Outgoing
                    && entry.message["command"] == "launch")
                .count(),
            1
        );
    }
    assert!(manager.configure(&id, vec![]).is_err());
    manager.close(&id).unwrap();
}

#[test]
fn stopped_thread_identifiers_preserve_zero_and_negative_integers() {
    let manager = manager();
    let id = manager.open_client_transport().unwrap();
    for thread_id in [0, -1] {
        feed(
            &manager,
            &id,
            vec![json!({"seq":0,"type":"event","event":"stopped","body":{"threadId":thread_id}})],
        );
        assert_eq!(
            manager.read(&id, 0, 128).unwrap().session.stopped_thread_id,
            Some(thread_id)
        );
    }
}

#[test]
fn inspection_start_refuses_an_old_pause_before_sending_a_watch_expression() {
    use ash_debug_contract::DebugInspection;
    let manager = manager();
    let id = manager.open_client_transport().unwrap();
    feed(
        &manager,
        &id,
        vec![json!({"seq":0,"type":"event","event":"stopped","body":{"threadId":1}})],
    );
    let epoch = manager
        .read(&id, 0, 128)
        .unwrap()
        .session
        .inspection_revision;
    feed(
        &manager,
        &id,
        vec![json!({"seq":0,"type":"event","event":"invalidated"})],
    );
    assert!(
        manager
            .inspect(
                &id,
                DebugInspection::Watch {
                    expressions: vec!["side_effect()".into()],
                    frame_id: Some(1)
                },
                epoch
            )
            .unwrap()
            .is_none()
    );
    assert!(
        !manager
            .read(&id, 0, 128)
            .unwrap()
            .messages
            .iter()
            .any(|entry| entry.direction == DebugMessageDirection::Outgoing)
    );
    let current = manager
        .read(&id, 0, 128)
        .unwrap()
        .session
        .inspection_revision;
    assert!(
        manager
            .inspect(
                &id,
                DebugInspection::Variables {
                    variables_reference: 1
                },
                current
            )
            .unwrap()
            .is_some()
    );
    manager.close(&id).unwrap();
}

#[test]
fn raw_requests_cannot_bypass_the_breakpoint_intent_owner() {
    let manager = manager();
    let id = manager.open_client_transport().unwrap();
    for command in [
        "setExceptionBreakpoints",
        "setBreakpoints",
        "setFunctionBreakpoints",
        "setDataBreakpoints",
        "setInstructionBreakpoints",
    ] {
        assert!(
            manager
                .request(&id, command, Some(json!({"breakpoints":[]})))
                .is_err()
        );
    }
    assert!(manager.read(&id, 0, 128).unwrap().messages.is_empty());
    manager.close(&id).unwrap();
}

#[test]
fn an_output_object_retains_its_original_pause_epoch_and_cannot_query_a_later_stop() {
    use ash_debug_contract::DebugSessionAdmission;
    use std::sync::Arc;
    let manager = Arc::new(manager());
    let registry = Arc::new(crate::DebugSessions::default());
    registry
        .reserve(
            1,
            DebugSessionAdmission {
                id: "public".into(),
                workspace_id: "workspace".into(),
                parent_id: None,
                lifecycle_managed_by_parent: false,
                merge_console: false,
                no_debug: None,
            },
        )
        .unwrap();
    let id = manager.open_client_transport().unwrap();
    manager.set_public_id(&id, "public".into()).unwrap();
    manager.attach(&id, registry.clone(), 1, None).unwrap();
    feed(
        &manager,
        &id,
        vec![
            json!({"seq":0,"type":"event","event":"stopped","body":{"threadId":1}}),
            json!({"seq":0,"type":"event","event":"output","body":{"variablesReference":7}}),
        ],
    );
    let output = registry.console(1, "public").unwrap();
    let epoch = output.entries[0].inspection_revision.unwrap();
    feed(
        &manager,
        &id,
        vec![
            json!({"seq":0,"type":"event","event":"continued"}),
            json!({"seq":0,"type":"event","event":"stopped","body":{"threadId":1}}),
        ],
    );
    assert_eq!(
        manager
            .inspect(
                &id,
                ash_debug_contract::DebugInspection::Variables {
                    variables_reference: 7
                },
                epoch
            )
            .unwrap(),
        None
    );
    assert!(
        !manager
            .read(&id, 0, 128)
            .unwrap()
            .messages
            .iter()
            .any(|entry| entry.message["command"] == "variables")
    );
}

#[test]
fn request_identity_is_the_session_dap_sequence_used_by_cancel() {
    let manager = manager();
    let id = manager.open_client_transport().unwrap();
    feed(
        &manager,
        &id,
        vec![
            json!({"seq":0,"type":"event","event":"capabilities","body":{"capabilities":{"supportsCompletionsRequest":true,"supportsCancelRequest":true}}}),
        ],
    );
    let completion = manager
        .request(
            &id,
            "completions",
            Some(json!({"text":"a.","line":1,"column":3,"frameId":0})),
        )
        .unwrap();
    let cancellation = manager
        .request(&id, "cancel", Some(json!({"requestId":completion})))
        .unwrap();
    let read = manager.read(&id, 0, 128).unwrap();
    let outgoing: Vec<_> = read
        .messages
        .iter()
        .filter(|entry| entry.direction == DebugMessageDirection::Outgoing)
        .collect();
    assert_eq!(outgoing[0].message["seq"], completion);
    assert_eq!(outgoing[0].message["command"], "completions");
    assert_eq!(outgoing[1].message["seq"], cancellation);
    assert_ne!(completion, cancellation);
    assert_eq!(
        outgoing[1].message["arguments"]["requestId"],
        outgoing[0].message["seq"]
    );
    // DAP cancellation is advisory: pair both responses independently even
    // when the adapter finishes the original completion after acknowledging it.
    feed(
        &manager,
        &id,
        vec![
            reply_message(cancellation, "cancel", json!({})),
            reply_message(completion, "completions", json!({"targets":[]})),
        ],
    );
    assert!(matches!(
        manager.response(&id, cancellation).unwrap(),
        DebugResponse::Complete(_)
    ));
    assert!(matches!(
        manager.response(&id, completion).unwrap(),
        DebugResponse::Complete(_)
    ));
    manager.close(&id).unwrap();
}
