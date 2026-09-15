use super::*;
use ash_app_server_protocol::protocol::common::{ClientCapabilities, ClientInfo};
use ash_app_server_protocol::protocol::session::{
    SessionCreateParams, SessionRequest, SessionRequestParams, SessionRequestResult,
    SessionSubscribeParams,
};
use ash_app_server_protocol::protocol::turn::InputItem;
use ash_async_utils::CancellationToken;
use ash_core::InMemoryThreadStore;
use ash_core::ThreadController;
use ash_protocol::{
    CommandId, ContentPart, InputItem as ModelInputItem, ModelRequest, ModelResponse, ResponseItem,
    StopReason, ThreadEvent, ThreadUpdate,
};
use core_api::CoreError;
use core_api::ModelService;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

#[test]
fn closing_session_does_not_block_on_a_full_event_channel() {
    let (sender, _receiver) = std::sync::mpsc::sync_channel(1);
    sender
        .send(AppServerEvent::ConnectionClosed(
            ConnectionCloseReason::DriverStopped,
        ))
        .unwrap();
    let closing = AtomicBool::new(true);

    assert!(!send_event(
        &sender,
        AppServerEvent::ConnectionClosed(ConnectionCloseReason::Shutdown),
        &closing,
    ));
}

#[test]
fn embedded_session_delivers_idle_notifications_without_a_polling_request() {
    let server = Arc::new(app_server());
    let mut session = AppServerSession::from_embedded_host(
        server,
        ClientInfo {
            name: "session-test".into(),
            version: "1".into(),
        },
        ClientCapabilities::default(),
    )
    .unwrap();
    assert_eq!(session.process_id(), None);
    let events = session.take_events().unwrap();
    let mut client = session.client();
    let created_session = client
        .create_session(SessionCreateParams {
            agent_id: None,
            agent: ash_protocol::AgentRoleSelection::Default,
            command_id: command_id("session"),
            title: "session".into(),
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
                thread_id: created_thread.thread_id,
                expected_sequence: 1,
                approval_mode: ash_protocol::ApprovalMode::default(),
                tool_mode: None,
                input: vec![InputItem::Text {
                    text: "hello".into(),
                }],
            },
        })
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(2);
    let completed = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "completion notification timed out");
        let event = events.recv_timeout(remaining).expect("event arrives");
        if let AppServerEvent::Notification(ServerNotification::SessionThreadUpdate(update)) = event
            && matches!(
                update.update,
                ThreadUpdate::Committed {
                    event: ThreadEvent::TurnCompleted { .. }
                }
            )
        {
            break true;
        }
    };
    assert!(completed);

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
}

#[test]
fn shutdown_rejects_requests_from_surviving_client_clones() {
    let mut session = AppServerSession::from_embedded_host(
        Arc::new(app_server()),
        ClientInfo {
            name: "shutdown-test".into(),
            version: "1".into(),
        },
        ClientCapabilities::default(),
    )
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
}

#[test]
fn request_handle_clones_share_initialization_and_request_ids() {
    let session = AppServerSession::from_embedded_host(
        Arc::new(app_server()),
        ClientInfo {
            name: "clone-test".into(),
            version: "1".into(),
        },
        ClientCapabilities::default(),
    )
    .unwrap();
    let mut first = session.client();
    let mut second = session.client();

    assert_eq!(
        first.initialization().unwrap(),
        second.initialization().unwrap()
    );
    first.list_sessions().unwrap();
    second.list_sessions().unwrap();

    session.shutdown().unwrap();
}

fn command_id(label: &str) -> CommandId {
    CommandId::new(format!("{label}-command")).unwrap()
}

fn app_server() -> AppServer {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    AppServer::new(threads, Arc::new(TestModel))
}

struct TestModel;

impl ModelService for TestModel {
    fn invoke(
        &self,
        _: core_api::ModelSelection<'_>,
        request: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        let prompt = request
            .input
            .iter()
            .rev()
            .find_map(|item| match item {
                ModelInputItem::Message(message) => {
                    message.content.iter().find_map(|content| match content {
                        ContentPart::Text(text) => Some(text.as_str()),
                        ContentPart::ImageUrl { .. } => None,
                        ContentPart::ImageAttachment { .. } => None,
                    })
                }
                ModelInputItem::ToolResult(_) => None,
            })
            .unwrap_or_default();
        Ok(ModelResponse {
            output: vec![ResponseItem::Text(format!("Ash: {prompt}"))],
            usage: None,
            billing: None,
            stop_reason: StopReason::Completed,
        })
    }
}

#[test]
fn memory_recording_collects_product_counters_exports_and_stops_for_rust_products() {
    use crate::MemoryRecording;
    use ash_memory_diagnostics::MemoryMetric;
    use ash_memory_diagnostics::MemoryMetricKind;
    use ash_memory_diagnostics::MemoryOrigin;
    use ash_memory_diagnostics::MemoryProduct;
    use ash_memory_diagnostics::MemoryStatus;
    for product in [MemoryProduct::Tui, MemoryProduct::RustGui] {
        let session = AppServerSession::from_embedded_host(
            Arc::new(app_server()),
            ClientInfo {
                name: "memory-test".into(),
                version: "1".into(),
            },
            ClientCapabilities::default(),
        )
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
    }
}

#[test]
fn dropping_memory_recording_stops_backend_without_closing_its_connection() {
    use crate::MemoryRecording;
    use ash_app_server_protocol::protocol::memory_diagnostics::MemoryDiagnosticsSessionParams;
    use ash_memory_diagnostics::MemoryMetric;
    use ash_memory_diagnostics::MemoryMetricKind;
    use ash_memory_diagnostics::MemoryProduct;
    use ash_memory_diagnostics::MemoryStatus;
    let session = AppServerSession::from_embedded_host(
        Arc::new(app_server()),
        ClientInfo {
            name: "memory-drop-test".into(),
            version: "1".into(),
        },
        ClientCapabilities::default(),
    )
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
}

#[test]
fn failed_memory_evidence_remains_visible_after_backend_cleanup() {
    use crate::MemoryRecording;
    use ash_app_server_protocol::protocol::memory_diagnostics::MemoryDiagnosticsSessionParams;
    use ash_memory_diagnostics::MemoryMetric;
    use ash_memory_diagnostics::MemoryMetricKind;
    use ash_memory_diagnostics::MemoryProduct;
    use ash_memory_diagnostics::MemoryStatus;
    let session = AppServerSession::from_embedded_host(
        Arc::new(app_server()),
        ClientInfo {
            name: "memory-failure-test".into(),
            version: "1".into(),
        },
        ClientCapabilities::default(),
    )
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
}
