use std::num::NonZeroU32;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use ash_lsp::LanguageServerCommand;
use ash_lsp::LanguageServerName;
use ash_lsp::lsp_types::{Position, PositionEncodingKind};

use super::*;
use crate::projection::{byte_offset_for_position, byte_range_for_lsp_range};
use crate::{LanguageDocumentRevision, LanguageServerRestartPolicy};

#[derive(Default)]
struct RecordingSink {
    events: Mutex<Vec<LanguageServiceEvent>>,
    changed: Condvar,
}

impl RecordingSink {
    fn wait_for(&self, predicate: impl Fn(&LanguageServiceEvent) -> bool) -> LanguageServiceEvent {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut events = self.events.lock().expect("event lock");
        loop {
            if let Some(event) = events.iter().find(|event| predicate(event)).cloned() {
                return event;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "timed out waiting for language event");
            events = self
                .changed
                .wait_timeout(events, remaining)
                .expect("event wait")
                .0;
        }
    }

    fn snapshot(&self) -> Vec<LanguageServiceEvent> {
        self.events.lock().expect("event lock").clone()
    }
}

impl LanguageServiceEventSink for RecordingSink {
    fn on_event(&self, event: LanguageServiceEvent) {
        self.events.lock().expect("event lock").push(event);
        self.changed.notify_all();
    }
}

#[derive(Default)]
struct RecordingMetrics {
    metrics: Mutex<Vec<LanguageRequestMetric>>,
    changed: Condvar,
}

impl RecordingMetrics {
    fn wait_for(
        &self,
        predicate: impl Fn(&LanguageRequestMetric) -> bool,
    ) -> LanguageRequestMetric {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut metrics = self.metrics.lock().expect("metric lock");
        loop {
            if let Some(metric) = metrics.iter().find(|metric| predicate(metric)).cloned() {
                return metric;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(
                !remaining.is_zero(),
                "timed out waiting for language metric"
            );
            metrics = self
                .changed
                .wait_timeout(metrics, remaining)
                .expect("metric wait")
                .0;
        }
    }
}

impl LspRequestMetricsSink for RecordingMetrics {
    fn record(&self, metric: LanguageRequestMetric) {
        self.metrics.lock().expect("metric lock").push(metric);
        self.changed.notify_all();
    }
}

#[test]
fn disabled_service_retains_nonblocking_document_contract_without_starting_servers() {
    let workspace = tempfile::tempdir().expect("workspace");
    let service = LspManager::start(
        LspManagerConfiguration::disabled(workspace.path()),
        Arc::new(NoopLanguageServiceEventSink),
    )
    .expect("start disabled language service");
    let document = LspDocumentSnapshot::new(
        "src/main.rs",
        "rust",
        LanguageDocumentRevision::INITIAL,
        "fn main() {}",
    )
    .expect("document");

    service
        .synchronize_document(document)
        .expect("queue document");
    service
        .set_enablement(LspManagerEnablement::Disabled)
        .expect("keep disabled");
    service.shutdown().expect("shutdown");
}

#[tokio::test]
async fn disabling_supervisor_aborts_pending_retry_tasks() {
    let workspace = tempfile::tempdir().expect("workspace");
    let (commands, _receiver) = tokio::sync::mpsc::unbounded_channel();
    let mut supervisor = Supervisor::new(
        LspManagerConfiguration::disabled(workspace.path()),
        Arc::new(NoopLanguageServiceEventSink),
        None,
        commands,
    );
    let (finished, receiver) = tokio::sync::oneshot::channel();
    let retry = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(60)).await;
        let _ = finished.send(());
    });
    supervisor.retry_tasks.insert(
        LanguageServerName::new("rust-analyzer").expect("server name"),
        retry,
    );

    supervisor.disable().await;

    assert!(supervisor.retry_tasks.is_empty());
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(1), receiver).await,
        Ok(Err(_))
    ));
}

#[test]
fn request_facade_reports_missing_ready_capability_without_blocking_the_caller() {
    let workspace = tempfile::tempdir().expect("workspace");
    let sink = Arc::new(RecordingSink::default());
    let service = LspManager::start(
        LspManagerConfiguration::disabled(workspace.path()),
        sink.clone(),
    )
    .expect("start disabled language service");
    let path = workspace.path().join("src/main.rs");
    service
        .synchronize_document(
            LspDocumentSnapshot::new(
                &path,
                "rust",
                LanguageDocumentRevision::INITIAL,
                "fn main() {}",
            )
            .expect("document"),
        )
        .expect("synchronize");
    let request_id = service
        .request_hover(
            &path,
            LanguageDocumentRevision::INITIAL,
            LanguageDocumentPosition::new(0, 3),
        )
        .expect("queue hover");

    assert!(matches!(
        sink.wait_for(|event| matches!(
            event,
            LanguageServiceEvent::RequestFailed { request_id: failed, .. } if *failed == request_id
        )),
        LanguageServiceEvent::RequestFailed {
            kind: LanguageRequestKind::Hover,
            message,
            ..
        } if message.contains("not routed")
    ));
    service.shutdown().expect("shutdown");
}

#[test]
fn metrics_report_rejected_requests_without_source_or_query_payloads() {
    let workspace = tempfile::tempdir().expect("workspace");
    let metrics = Arc::new(RecordingMetrics::default());
    let service = LspManager::start_with_metrics(
        LspManagerConfiguration::disabled(workspace.path()),
        Arc::new(NoopLanguageServiceEventSink),
        metrics.clone(),
    )
    .expect("start disabled language service");
    let path = workspace.path().join("src/main.rs");
    service
        .synchronize_document(
            LspDocumentSnapshot::new(
                &path,
                "rust",
                LanguageDocumentRevision::INITIAL,
                "fn private_source_text() {}",
            )
            .expect("document"),
        )
        .expect("synchronize");
    service
        .request_definition(
            &path,
            LanguageDocumentRevision::INITIAL,
            LanguageDocumentPosition::new(0, 3),
        )
        .expect("request");

    let metric = metrics.wait_for(|metric| metric.kind == LanguageRequestKind::Definition);
    assert_eq!(metric.outcome, LanguageRequestMetricOutcome::Rejected);
    assert_eq!(metric.server, None);
    assert_eq!(metric.result_count, 0);
    service.shutdown().expect("shutdown");
}

#[tokio::test]
async fn cancelling_an_in_flight_request_aborts_work_and_records_the_terminal_outcome() {
    let workspace = tempfile::tempdir().expect("workspace");
    let (commands, _receiver) = tokio::sync::mpsc::unbounded_channel();
    let metrics = Arc::new(RecordingMetrics::default());
    let metrics_sink: Arc<dyn LspRequestMetricsSink> = metrics.clone();
    let mut supervisor = Supervisor::new(
        LspManagerConfiguration::disabled(workspace.path()),
        Arc::new(NoopLanguageServiceEventSink),
        Some(metrics_sink),
        commands,
    );
    let request_id = LanguageRequestId::new(9);
    let server = LanguageServerName::new("rust-analyzer").expect("server");
    let (finished, receiver) = tokio::sync::oneshot::channel();
    let cancellation = ash_async_utils::CancellationSource::new();
    let cancellation_token = cancellation.token();
    let _ = tokio::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(60)) => {
                let _ = finished.send(());
            }
            _ = cancellation_token.cancelled() => {}
        }
    });
    supervisor.in_flight_requests.insert(
        request_id,
        InFlightLanguageRequest {
            cancellation,
            kind: LanguageRequestKind::References,
            server,
            server_epoch: 3,
            configuration_generation: 4,
            service_generation: 5,
            cold_for_incarnation: true,
            started: Instant::now(),
        },
    );

    supervisor.cancel_language_request(request_id);

    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(1), receiver).await,
        Ok(Err(_))
    ));
    let metric = metrics.wait_for(|metric| metric.kind == LanguageRequestKind::References);
    assert_eq!(metric.outcome, LanguageRequestMetricOutcome::Cancelled);
    assert_eq!(metric.server_incarnation, Some(3));
    assert_eq!(metric.configuration_generation, 4);
    assert_eq!(metric.service_generation, 5);
    assert!(metric.cold_for_incarnation);
}

#[test]
fn enabled_service_reports_resolved_command_start_failure_without_panicking() {
    let workspace = tempfile::tempdir().expect("workspace");
    let definition = LanguageServerDefinition::new(
        "missing-rust",
        ["rust"],
        LanguageServerCommand::new("ash-language-server-that-does-not-exist"),
    )
    .expect("definition");
    let sink = Arc::new(RecordingSink::default());
    let service = LspManager::start(
        LspManagerConfiguration::enabled(workspace.path(), vec![definition])
            .with_restart_policy(LanguageServerRestartPolicy::Never),
        sink.clone(),
    )
    .expect("start supervisor");

    let failed = sink.wait_for(|event| {
        matches!(
            event,
            LanguageServiceEvent::ServerStateChanged {
                state: LanguageServerState::Failed(_),
                ..
            }
        )
    });
    assert!(matches!(
        failed,
        LanguageServiceEvent::ServerStateChanged { server, .. } if server == "missing-rust"
    ));
    service.shutdown().expect("shutdown");
}

#[test]
fn bounded_restart_policy_enters_crash_loop_after_exactly_its_retry_budget() {
    let workspace = tempfile::tempdir().expect("workspace");
    let definition = LanguageServerDefinition::new(
        "missing-rust",
        ["rust"],
        LanguageServerCommand::new("ash-language-server-that-does-not-exist"),
    )
    .expect("definition");
    let policy = LanguageServerRestartPolicy::bounded_exponential(
        NonZeroU32::new(2).unwrap(),
        Duration::ZERO,
        Duration::ZERO,
        Duration::from_secs(60),
    );
    let sink = Arc::new(RecordingSink::default());
    let service = LspManager::start(
        LspManagerConfiguration::enabled(workspace.path(), vec![definition])
            .with_restart_policy(policy),
        sink.clone(),
    )
    .expect("start supervisor");

    let crash_loop = sink.wait_for(|event| {
        matches!(
            event,
            LanguageServiceEvent::ServerStateChanged {
                state: LanguageServerState::CrashLoop { .. },
                ..
            }
        )
    });

    assert!(matches!(
        crash_loop,
        LanguageServiceEvent::ServerStateChanged {
            state: LanguageServerState::CrashLoop {
                restart_attempts: 2,
                ..
            },
            ..
        }
    ));
    let events = sink.snapshot();
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                event,
                LanguageServiceEvent::ServerStateChanged {
                    state: LanguageServerState::Starting,
                    ..
                }
            ))
            .count(),
        3
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                event,
                LanguageServiceEvent::ServerStateChanged {
                    state: LanguageServerState::BackingOff { .. },
                    ..
                }
            ))
            .count(),
        2
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                event,
                LanguageServiceEvent::ServerMessage {
                    server,
                    source: LanguageServerMessageSource::Service,
                    ..
                } if server == "missing-rust"
            ))
            .count(),
        2
    );
    service.shutdown().expect("shutdown");
}

#[test]
fn disabling_during_backoff_cancels_the_pending_restart_generation() {
    let workspace = tempfile::tempdir().expect("workspace");
    let definition = LanguageServerDefinition::new(
        "missing-rust",
        ["rust"],
        LanguageServerCommand::new("ash-language-server-that-does-not-exist"),
    )
    .expect("definition");
    let policy = LanguageServerRestartPolicy::bounded_exponential(
        NonZeroU32::new(3).unwrap(),
        Duration::from_millis(80),
        Duration::from_millis(80),
        Duration::from_secs(60),
    );
    let sink = Arc::new(RecordingSink::default());
    let service = LspManager::start(
        LspManagerConfiguration::enabled(workspace.path(), vec![definition])
            .with_restart_policy(policy),
        sink.clone(),
    )
    .expect("start supervisor");
    sink.wait_for(|event| {
        matches!(
            event,
            LanguageServiceEvent::ServerStateChanged {
                state: LanguageServerState::BackingOff { attempt: 1, .. },
                ..
            }
        )
    });

    service
        .set_enablement(LspManagerEnablement::Disabled)
        .expect("disable service");
    sink.wait_for(|event| {
        matches!(
            event,
            LanguageServiceEvent::ServerStateChanged {
                state: LanguageServerState::Stopped,
                ..
            }
        )
    });
    std::thread::sleep(Duration::from_millis(160));

    assert_eq!(
        sink.snapshot()
            .iter()
            .filter(|event| matches!(
                event,
                LanguageServiceEvent::ServerStateChanged {
                    state: LanguageServerState::Starting,
                    ..
                }
            ))
            .count(),
        1
    );
    service.shutdown().expect("shutdown");
}

#[tokio::test]
async fn transport_close_during_starting_cannot_become_a_false_ready_server() {
    let workspace = tempfile::tempdir().expect("workspace");
    let definition = LanguageServerDefinition::new(
        "early-exit-rust",
        ["rust"],
        LanguageServerCommand::new("unused-in-this-state-machine-test"),
    )
    .expect("definition");
    let configuration = LspManagerConfiguration::enabled(workspace.path(), vec![definition])
        .with_restart_policy(LanguageServerRestartPolicy::Never);
    let sink = Arc::new(RecordingSink::default());
    let (commands, _command_rx) = mpsc::unbounded_channel();
    let mut supervisor = Supervisor::new(configuration, sink.clone(), None, commands);
    let server = LanguageServerName::new("early-exit-rust").expect("server name");
    let managed = supervisor.servers.get_mut(&server).expect("managed server");
    managed.epoch = 1;
    managed.phase = ManagedServerPhase::Starting;

    supervisor
        .handle_protocol_event(
            server.clone(),
            1,
            LanguageServerEvent::ServerStderr("startup details".into()),
        )
        .await;
    supervisor
        .handle_protocol_event(
            server.clone(),
            1,
            LanguageServerEvent::TransportClosed {
                message: "closed immediately after initialized".into(),
            },
        )
        .await;

    assert_eq!(
        supervisor.servers.get(&server).map(|server| server.phase),
        Some(ManagedServerPhase::Terminal)
    );
    assert!(sink.snapshot().iter().any(|event| matches!(
        event,
        LanguageServiceEvent::ServerMessage {
            server,
            source: LanguageServerMessageSource::Stderr,
            message,
            ..
        } if server == "early-exit-rust" && message == "startup details"
    )));
    assert!(sink.snapshot().iter().any(|event| matches!(
        event,
        LanguageServiceEvent::ServerStateChanged {
            server,
            state: LanguageServerState::Failed(message),
        } if server == "early-exit-rust" && message.contains("immediately after initialized")
    )));
}

#[cfg(unix)]
#[test]
fn initialized_stdio_crashes_restart_and_stop_at_the_crash_loop_budget() {
    let workspace = tempfile::tempdir().expect("workspace");
    let launches = workspace.path().join("launches");
    let script = r#"
cr=$(printf '\r')
length=0
while IFS= read -r line; do
  line=${line%"$cr"}
  if [ -z "$line" ]; then
    break
  fi
  case "$line" in
    Content-Length:*) length=${line#Content-Length: } ;;
  esac
done
dd bs=1 count="$length" >/dev/null 2>/dev/null
printf x >> "$ASH_LSP_LAUNCHES"
response='{"jsonrpc":"2.0","id":1,"result":{"capabilities":{"textDocumentSync":{"openClose":true,"change":1}}}}'
printf 'Content-Length: %s\r\n\r\n%s' "${#response}" "$response"
sleep 0.15
exit 42
"#;
    let definition = LanguageServerDefinition::new(
        "crashing-rust",
        ["rust"],
        LanguageServerCommand::new("/bin/sh")
            .with_arguments(["-c", script])
            .with_environment("ASH_LSP_LAUNCHES", launches.as_os_str()),
    )
    .expect("definition");
    let policy = LanguageServerRestartPolicy::bounded_exponential(
        NonZeroU32::new(1).unwrap(),
        Duration::ZERO,
        Duration::ZERO,
        Duration::from_secs(60),
    );
    let sink = Arc::new(RecordingSink::default());
    let service = LspManager::start(
        LspManagerConfiguration::enabled(workspace.path(), vec![definition])
            .with_restart_policy(policy),
        sink.clone(),
    )
    .expect("start supervisor");
    sink.wait_for(|event| {
        matches!(
            event,
            LanguageServiceEvent::ServerStateChanged {
                state: LanguageServerState::Ready,
                ..
            }
        )
    });
    service
        .synchronize_document(
            LspDocumentSnapshot::new(
                workspace.path().join("src/main.rs"),
                "rust",
                LanguageDocumentRevision::INITIAL,
                "fn main() {}",
            )
            .expect("document"),
        )
        .expect("synchronize document");

    sink.wait_for(|event| {
        matches!(
            event,
            LanguageServiceEvent::ServerStateChanged {
                state: LanguageServerState::CrashLoop {
                    restart_attempts: 1,
                    ..
                },
                ..
            }
        )
    });

    let events = sink.snapshot();
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                event,
                LanguageServiceEvent::ServerStateChanged {
                    state: LanguageServerState::Ready,
                    ..
                }
            ))
            .count(),
        2
    );
    assert!(events.iter().any(|event| matches!(
        event,
        LanguageServiceEvent::Diagnostics(diagnostics) if diagnostics.diagnostics().is_empty()
    )));
    assert_eq!(std::fs::read(&launches).expect("launch count").len(), 2);
    service.shutdown().expect("shutdown");
}

#[test]
fn definitions_reject_ambiguous_language_routes_before_starting_a_thread() {
    let workspace = tempfile::tempdir().expect("workspace");
    let first =
        LanguageServerDefinition::new("first", ["rust"], LanguageServerCommand::new("first"))
            .expect("first");
    let second =
        LanguageServerDefinition::new("second", ["rust"], LanguageServerCommand::new("second"))
            .expect("second");

    let result = LspManager::start(
        LspManagerConfiguration::enabled(workspace.path(), vec![first, second]),
        Arc::new(NoopLanguageServiceEventSink),
    );

    assert!(matches!(
        result,
        Err(LspManagerError::DuplicateLanguage(language)) if language == "rust"
    ));
}

#[test]
fn lsp_positions_convert_to_utf8_byte_ranges_without_splitting_scalars() {
    let text = "零a😀z\r\nnext";
    let utf16 = byte_range_for_lsp_range(
        text,
        Position::new(0, 1),
        Position::new(0, 4),
        &PositionEncodingKind::UTF16,
    )
    .expect("utf16 range");
    let utf8 = byte_range_for_lsp_range(
        text,
        Position::new(1, 0),
        Position::new(1, 4),
        &PositionEncodingKind::UTF8,
    )
    .expect("utf8 range");

    assert_eq!(&text[utf16], "a😀");
    assert_eq!(&text[utf8], "next");
    assert!(
        byte_offset_for_position(text, Position::new(0, 3), &PositionEncodingKind::UTF16).is_none()
    );
}
