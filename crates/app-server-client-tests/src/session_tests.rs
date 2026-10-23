use ash_app_server_client::AppServerEvent;
use ash_app_server_client::AppServerSession;
use ash_app_server_client::ClientError;
use ash_app_server_client::ConnectionCloseReason;
use ash_app_server_client::InProcessClientOptions;
use ash_app_server_client::MemoryRecording;
use ash_app_server_client::ServerNotification;
use ash_app_server_client::SessionStateMode;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_app_server_protocol::protocol::session::SessionCreateParams;
use ash_app_server_protocol::protocol::session::SessionRequest;
use ash_app_server_protocol::protocol::session::SessionRequestParams;
use ash_app_server_protocol::protocol::session::SessionRequestResult;
use ash_app_server_protocol::protocol::session::SessionSubscribeParams;
use ash_app_server_protocol::protocol::turn::InputItem;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_client::OperationStreamSink;
use ash_protocol::CommandId;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadItem;
use ash_protocol::ThreadUpdate;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

fn command_id(label: &str) -> CommandId {
    CommandId::new(format!("{label}-command")).unwrap()
}

fn embedded_options(profile: &Path, name: &str) -> InProcessClientOptions {
    InProcessClientOptions::new(
        profile,
        ClientInfo {
            name: name.into(),
            version: "1".into(),
        },
    )
    .with_codex_home(profile.join("codex"))
    .with_session_state_mode(SessionStateMode::Ephemeral)
    .without_built_in_skills()
    .with_model_operation_client(Arc::new(FixtureModel))
}

// Exercise the public embedded startup and real model adapter without network or host credentials.
struct FixtureModel;

impl OperationClient for FixtureModel {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ash_client::ClientError> {
        panic!(
            "unexpected non-streaming fixture request: {}",
            request.url()
        );
    }

    fn execute_streaming(
        &self,
        request: &ClientRequest,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ash_client::ClientError> {
        assert_eq!(request.url(), "http://localhost:11434/v1/chat/completions");
        sink.emit(b"data: {\"id\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Ash: hello\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")?;
        Ok(ClientResponse::new(200, Vec::new(), Vec::new()))
    }
}

#[test]
fn dropping_memory_recording_stops_backend_without_closing_its_connection() {
    use ash_app_server_protocol::protocol::memory_diagnostics::MemoryDiagnosticsSessionParams;
    use ash_memory_diagnostics::MemoryMetric;
    use ash_memory_diagnostics::MemoryMetricKind;
    use ash_memory_diagnostics::MemoryProduct;
    use ash_memory_diagnostics::MemoryStatus;
    let profile = tempfile::tempdir().unwrap();
    let session =
        AppServerSession::start_embedded(embedded_options(profile.path(), "memory-drop-test"))
            .unwrap();
    let mut client = session.client();
    let recording = MemoryRecording::start(
        client.clone(),
        MemoryProduct::Tui,
        "drop-test".into(),
        || {
            vec![MemoryMetric {
                kind: MemoryMetricKind::UiObjects,
                value: Some(1),
                unavailable: None,
            }]
        },
    )
    .unwrap();
    let session_id = recording.session_id().to_owned();
    drop(recording);
    assert_eq!(
        client
            .read_memory_diagnostics(MemoryDiagnosticsSessionParams { session_id })
            .unwrap()
            .status,
        MemoryStatus::Stopped
    );
    session.shutdown().unwrap();
    drop(client);
    profile.close().unwrap();
}

#[test]
fn embedded_session_delivers_idle_notifications_without_a_polling_request() {
    let profile = tempfile::tempdir().unwrap();
    let mut session =
        AppServerSession::start_embedded(embedded_options(profile.path(), "session-test")).unwrap();
    assert_eq!(session.process_id(), None);
    let events = session.take_events().unwrap();
    let mut client = session.client();
    let revision = client.read_config().unwrap().revision;
    client
        .configure_provider(
            serde_json::from_value(serde_json::json!({
                "commandId": "fixture-provider",
                "expectedRevision": revision,
                "config": {
                    "connection": "ollama",
                    "provider": "ollama",
                    "modelContext": {"fixture": {"contextWindow": 32000}}
                }
            }))
            .unwrap(),
        )
        .unwrap();
    let created_session = client
        .create_session(SessionCreateParams {
            branch_name: None,
            agent_id: None,
            agent: ash_protocol::AgentRoleSelection::Default,
            command_id: command_id("session"),
            title: "session".into(),
            execution_target: None,
        })
        .unwrap();
    let created_thread = client
        .request_session(SessionRequestParams {
            command_id: command_id("thread"),
            session_id: created_session.session.session_id.clone(),
            request: SessionRequest::CreateThread {
                agent_id: None,
                title: "thread".into(),
            },
        })
        .unwrap();
    let SessionRequestResult::Thread(created_thread) = created_thread else {
        panic!("Session request did not return a Thread result");
    };
    client
        .subscribe_session(SessionSubscribeParams {
            session_id: created_session.session.session_id.clone(),
        })
        .unwrap();
    client
        .request_session(SessionRequestParams {
            command_id: command_id("turn"),
            session_id: created_session.session.session_id,
            request: SessionRequest::StartTurn {
                ide_window_id: None,
                thread_id: created_thread.thread_id,
                expected_sequence: 1,
                mode: ash_protocol::CollaborationMode::Agent,
                approval_mode: Some(ash_protocol::ApprovalMode::default()),
                model: Some(ModelRef::new(
                    ProviderId::new("ollama").unwrap(),
                    ModelId::new("fixture").unwrap(),
                )),
                reasoning_effort: None,
                tool_mode: None,
                input: vec![InputItem::Text {
                    text: "hello".into(),
                }],
            },
        })
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(2);
    let mut output = None;
    let completed = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "completion notification timed out");
        let event = events.recv_timeout(remaining).expect("event arrives");
        if let AppServerEvent::Notification(ServerNotification::SessionThreadUpdate(update)) = event
        {
            match update.update {
                ThreadUpdate::Committed {
                    event:
                        ThreadEvent::ItemCompleted {
                            item: ThreadItem::AgentMessage { text, .. },
                            ..
                        },
                } => output = Some(text),
                ThreadUpdate::Committed {
                    event: ThreadEvent::TurnCompleted { .. },
                } => break true,
                _ => {}
            }
        }
    };
    assert!(completed);
    assert_eq!(output.as_deref(), Some("Ash: hello"));

    session.shutdown().unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    let close_reason = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "shutdown notification timed out");
        if let AppServerEvent::ConnectionClosed(reason) =
            events.recv_timeout(remaining).expect("event arrives")
        {
            break reason;
        }
    };
    assert_eq!(close_reason, ConnectionCloseReason::Shutdown);
    drop(client);
    profile.close().unwrap();
}

#[test]
fn failed_memory_evidence_remains_visible_after_backend_cleanup() {
    use ash_app_server_protocol::protocol::memory_diagnostics::MemoryDiagnosticsSessionParams;
    use ash_memory_diagnostics::MemoryMetric;
    use ash_memory_diagnostics::MemoryMetricKind;
    use ash_memory_diagnostics::MemoryProduct;
    use ash_memory_diagnostics::MemoryStatus;
    let profile = tempfile::tempdir().unwrap();
    let session =
        AppServerSession::start_embedded(embedded_options(profile.path(), "memory-failure-test"))
            .unwrap();
    let mut client = session.client();
    let recording = MemoryRecording::start(
        client.clone(),
        MemoryProduct::Tui,
        "failure-test".into(),
        || {
            vec![
                MemoryMetric {
                    kind: MemoryMetricKind::UiObjects,
                    value: Some(1),
                    unavailable: None
                };
                2
            ]
        },
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let report = client
            .read_memory_diagnostics(MemoryDiagnosticsSessionParams {
                session_id: recording.session_id().into(),
            })
            .unwrap();
        if recording.report().is_err() && report.status == MemoryStatus::Stopped {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "failed collector did not stop its recording"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(recording);
    session.shutdown().unwrap();
    drop(client);
    profile.close().unwrap();
}

#[test]
fn memory_recording_collects_product_counters_exports_and_stops_for_rust_products() {
    use ash_memory_diagnostics::MemoryMetric;
    use ash_memory_diagnostics::MemoryMetricKind;
    use ash_memory_diagnostics::MemoryOrigin;
    use ash_memory_diagnostics::MemoryProduct;
    use ash_memory_diagnostics::MemoryStatus;
    for product in [MemoryProduct::Tui, MemoryProduct::RustGui] {
        let profile = tempfile::tempdir().unwrap();
        let session =
            AppServerSession::start_embedded(embedded_options(profile.path(), "memory-test"))
                .unwrap();
        let mut client = session.client();
        let mut recording =
            MemoryRecording::start(client.clone(), product, "memory-test".into(), || {
                vec![MemoryMetric {
                    kind: MemoryMetricKind::UiObjects,
                    value: Some(7),
                    unavailable: None,
                }]
            })
            .unwrap();
        assert_eq!(recording.status().unwrap(), MemoryStatus::Recording);
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let report = recording.report().unwrap();
            if let Some(target) = report
                .targets
                .iter()
                .find(|target| target.origin == MemoryOrigin::ClientHost)
            {
                assert!(
                    target
                        .latest
                        .metrics
                        .iter()
                        .any(|metric| metric.kind == MemoryMetricKind::UiObjects
                            && metric.value == Some(7))
                );
                assert!(
                    !target
                        .latest
                        .metrics
                        .iter()
                        .any(|metric| metric.kind == MemoryMetricKind::ResidentBytes),
                    "the embedded backend already reports this process's resident memory"
                );
                break;
            }
            assert!(Instant::now() < deadline, "client evidence did not arrive");
            std::thread::sleep(Duration::from_millis(10));
        }
        let report = recording.stop().unwrap();
        assert_eq!(report.status, MemoryStatus::Stopped);
        assert_eq!(recording.status().unwrap(), MemoryStatus::Stopped);
        assert_eq!(report, recording.stop().unwrap());
        let export = client
            .export_memory_bytes(recording.session_id().to_owned())
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&export).unwrap();
        assert_eq!(value["report"]["status"], "stopped");
        drop(recording);
        session.shutdown().unwrap();
        drop(client);
        profile.close().unwrap();
    }
}

#[test]
fn request_handle_clones_share_initialization_and_request_ids() {
    let profile = tempfile::tempdir().unwrap();
    let session =
        AppServerSession::start_embedded(embedded_options(profile.path(), "clone-test")).unwrap();
    let mut first = session.client();
    let mut second = session.client();

    assert_eq!(
        first.initialization().unwrap(),
        second.initialization().unwrap()
    );
    first.list_sessions().unwrap();
    second.list_sessions().unwrap();

    session.shutdown().unwrap();
    drop((first, second));
    profile.close().unwrap();
}

#[test]
fn shutdown_rejects_requests_from_surviving_client_clones() {
    let profile = tempfile::tempdir().unwrap();
    let mut session =
        AppServerSession::start_embedded(embedded_options(profile.path(), "shutdown-test"))
            .unwrap();
    let events = session.take_events().unwrap();
    let mut client = session.client();

    session.shutdown().unwrap();

    assert!(matches!(
        client.list_sessions(),
        Err(ClientError::Transport(message)) if message.contains("closed")
    ));
    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        AppServerEvent::ConnectionClosed(ConnectionCloseReason::Shutdown)
    );
    drop(client);
    profile.close().unwrap();
}
