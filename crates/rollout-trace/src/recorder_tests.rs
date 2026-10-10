use super::*;
use crate::InferencePurpose;
use ash_protocol::ModelRequest;
use ash_protocol::ModelStreamEvent;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use std::fs;

fn context() -> InferenceContext {
    InferenceContext {
        session_id: SessionId::new("session").unwrap(),
        thread_id: ThreadId::new("thread").unwrap(),
        turn_id: TurnId::new("turn").unwrap(),
        source_thread_sequence: 7,
        model: None,
        purpose: InferencePurpose::Agent,
    }
}
fn request() -> ModelRequest {
    serde_json::from_value(serde_json::json!({ "input": [], "tools": [], "toolChoice": {"type":"none"}, "parallelToolCalls": false })).unwrap()
}

#[test]
fn diagnostic_cancellation_preserves_ordered_messages_and_late_phase() {
    let root = crate::tests::temporary_root();
    let recorder = TraceRecorder::new(Some(root.clone()));
    let mut attempt = recorder.start_attempt(context(), &request());
    attempt.output(&ModelStreamEvent::MessageStarted {
        id: "progress".into(),
        phase: None,
    });
    attempt.output(&ModelStreamEvent::MessageDelta {
        id: "progress".into(),
        text: "working".into(),
    });
    attempt.output(&ModelStreamEvent::MessageCompleted(
        ash_protocol::AssistantMessage {
            id: "progress".into(),
            text: "working".into(),
            phase: Some(ash_protocol::MessagePhase::Commentary),
        },
    ));
    attempt.output(&ModelStreamEvent::MessageStarted {
        id: "answer".into(),
        phase: Some(ash_protocol::MessagePhase::PartialAnswer),
    });
    attempt.output(&ModelStreamEvent::MessageDelta {
        id: "answer".into(),
        text: "first answer".into(),
    });
    attempt.cancel("interrupted");
    let page = recorder.read(&context().session_id, 0, 500).unwrap();
    let reference = page
        .diagnostics
        .events
        .last()
        .unwrap()
        .event
        .payload()
        .unwrap();
    let payload = recorder
        .read_payload(
            &context().session_id,
            page.diagnostics.capture_id.as_ref().unwrap(),
            &reference.payload_id,
        )
        .unwrap();
    assert_eq!(
        payload["messages"],
        serde_json::json!([
            {"id":"progress", "text":"working", "phase":"commentary"},
            {"id":"answer", "text":"first answer", "phase":"partial_answer"}
        ])
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn diagnostic_cancellation_retains_partial_output_and_survives_reopen() {
    let root = crate::tests::temporary_root();
    let recorder = TraceRecorder::new(Some(root.clone()));
    let mut attempt = recorder.start_attempt(context(), &request());
    attempt.prepared_request(&request());
    attempt.output(&ModelStreamEvent::TextDelta("partial text".into()));
    attempt.output(&ModelStreamEvent::ReasoningDelta(
        "partial reasoning".into(),
    ));
    attempt.cancel("user interrupted");
    drop(attempt);
    let first = recorder.read(&context().session_id, 0, 1).unwrap();
    assert!(
        first.has_more,
        "root={root:?}; diagnostics={:?}",
        first.diagnostics
    );
    assert_eq!(first.cursor, 1);
    let capture = first.diagnostics.capture_id.unwrap();
    drop(recorder);
    let recorder = TraceRecorder::new(Some(root.clone()));
    let page = recorder.read(&context().session_id, 1, 2).unwrap();
    assert_eq!(page.cursor, 3);
    assert!(!page.has_more);
    let DiagnosticEventKind::ModelAttemptCancelled {
        partial_output: Some(payload),
        ..
    } = &page.diagnostics.events[1].event
    else {
        panic!("expected retained cancellation");
    };
    assert_eq!(
        recorder
            .read_payload(&context().session_id, &capture, &payload.payload_id)
            .unwrap(),
        serde_json::json!({ "text": "partial text", "reasoning": "partial reasoning", "messages": [], "truncated": false })
    );
    assert!(matches!(
        recorder.read_payload(
            &context().session_id,
            "another-capture",
            &payload.payload_id
        ),
        Err(DiagnosticError::CaptureChanged)
    ));
    assert!(matches!(
        recorder.read_payload(&context().session_id, &capture, "../../secret"),
        Err(DiagnosticError::NotFound)
    ));
    let directory = fs::read_dir(&root).unwrap().next().unwrap().unwrap().path();
    fs::write(
        directory
            .join("payloads")
            .join(format!("{}.json", payload.payload_id)),
        b"{}",
    )
    .unwrap();
    assert!(matches!(
        recorder.read_payload(&context().session_id, &capture, &payload.payload_id),
        Err(DiagnosticError::Storage(_))
    ));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn diagnostic_omission_and_unavailable_storage_do_not_fail_attempts() {
    let root = crate::tests::temporary_root();
    fs::create_dir_all(&root).unwrap();
    let blocked = root.join("file");
    fs::write(&blocked, "not a directory").unwrap();
    let recorder = TraceRecorder::new(Some(blocked));
    recorder
        .start_attempt(context(), &request())
        .fail("execution failed independently");
    let recorder = TraceRecorder::new(Some(root.join("capture")));
    let mut oversized = request();
    oversized.instructions = Some("x".repeat(MAX_PAYLOAD_BYTES + 1));
    let attempt = recorder.start_attempt(context(), &oversized);
    drop(attempt);
    let page = recorder.read(&context().session_id, 0, 500).unwrap();
    assert_eq!(
        page.diagnostics.recording_status,
        RecordingStatus::Incomplete
    );
    assert_eq!(page.diagnostics.events.len(), 2);
    assert_eq!(
        page.diagnostics.events[0].event.payload().unwrap().status,
        PayloadStatus::Omitted
    );
    assert!(matches!(
        page.diagnostics.events[1].event,
        DiagnosticEventKind::ModelAttemptAbandoned { .. }
    ));
    assert!(recorder.read(&context().session_id, 3, 10).is_err());
    assert!(recorder.read(&context().session_id, 0, 501).is_err());
    assert_eq!(
        TraceRecorder::default()
            .read(&context().session_id, 0, 10)
            .unwrap()
            .diagnostics
            .recording_status,
        RecordingStatus::Disabled
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn diagnostic_recovery_does_not_overwrite_orphaned_payloads() {
    let root = crate::tests::temporary_root();
    let recorder = TraceRecorder::new(Some(root.clone()));
    recorder.start_attempt(context(), &request()).fail("first");
    assert_eq!(
        recorder.flush(std::time::Duration::from_secs(2)),
        FlushOutcome::Complete
    );
    let directory = fs::read_dir(&root).unwrap().next().unwrap().unwrap().path();
    fs::write(
        directory.join("payloads/payload-999.json"),
        "{\"orphan\":true}",
    )
    .unwrap();
    drop(recorder);
    let recorder = TraceRecorder::new(Some(root.clone()));
    recorder.start_attempt(context(), &request()).fail("second");
    let page = recorder.read(&context().session_id, 2, 10).unwrap();
    assert_eq!(
        page.diagnostics.events[0]
            .event
            .payload()
            .unwrap()
            .payload_id,
        "payload-1000"
    );
    assert_eq!(
        fs::read_to_string(directory.join("payloads/payload-999.json")).unwrap(),
        "{\"orphan\":true}"
    );
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn diagnostic_payload_reads_reject_replaced_directories() {
    let root = crate::tests::temporary_root();
    let recorder = TraceRecorder::new(Some(root.clone()));
    recorder.start_attempt(context(), &request()).fail("first");
    let page = recorder.read(&context().session_id, 0, 10).unwrap();
    let reference = page.diagnostics.events[0].event.payload().unwrap();
    let directory = fs::read_dir(&root).unwrap().next().unwrap().unwrap().path();
    fs::rename(directory.join("payloads"), directory.join("replaced")).unwrap();
    std::os::unix::fs::symlink(directory.join("replaced"), directory.join("payloads")).unwrap();
    assert!(matches!(
        recorder.read_payload(
            &context().session_id,
            page.diagnostics.capture_id.as_ref().unwrap(),
            &reference.payload_id
        ),
        Err(DiagnosticError::Storage(_))
    ));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn trace_recorder_reports_actual_directory_state_without_creating_capture_data() {
    let root = crate::tests::temporary_root();
    assert_eq!(TraceRecorder::default().state(), RecorderState::Disabled);
    let recorder = TraceRecorder::new(Some(root.clone()));
    assert_eq!(
        recorder.state(),
        RecorderState::Enabled {
            directory: root.clone()
        }
    );
    assert!(!root.exists());
    fs::write(&root, b"not a directory").unwrap();
    assert!(
        matches!(recorder.state(), RecorderState::Unavailable { directory, .. } if directory == root)
    );
    fs::remove_file(root).unwrap();
}

#[test]
fn hook_evidence_is_opt_in_and_reopens_with_session_identity() {
    let scope = context();
    let evidence = serde_json::json!({"program":"hook", "input":"private input", "stderr":"failed", "exitCode":7});
    let disabled = TraceRecorder::new(None);
    disabled.record_hook(&scope.session_id, &scope.thread_id, None, "run", &evidence);
    assert!(
        disabled
            .read(&scope.session_id, 0, 10)
            .unwrap()
            .diagnostics
            .events
            .is_empty()
    );
    let root = crate::tests::temporary_root();
    let recorder = TraceRecorder::new(Some(root.clone()));
    recorder.record_hook(&scope.session_id, &scope.thread_id, None, "run", &evidence);
    drop(recorder);
    let recorder = TraceRecorder::new(Some(root.clone()));
    let capture = recorder.read(&scope.session_id, 0, 10).unwrap().diagnostics;
    assert_eq!(capture.events[0].turn_id, None);
    assert!(
        matches!(&capture.events[0].event, DiagnosticEventKind::HookRunRecorded { run_id, .. } if run_id == "run")
    );
    assert_eq!(
        recorder
            .read_payload(
                &scope.session_id,
                capture.capture_id.as_ref().unwrap(),
                &capture.events[0].event.payload().unwrap().payload_id
            )
            .unwrap(),
        evidence
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn disabled_observations_never_initialize_a_worker_or_copy_body_evidence() {
    let recorder = TraceRecorder::default();
    let mut input = request();
    input.instructions = Some("x".repeat(MAX_PAYLOAD_BYTES + 1));
    recorder.start_attempt(context(), &input).cancel("off");
    assert!(recorder.worker.get().is_none());
    assert!(recorder.storage.writers.lock().unwrap().is_empty());
    assert_eq!(
        recorder.flush(std::time::Duration::ZERO),
        FlushOutcome::Complete
    );
    assert!(
        core_api::ExecutionDiagnostics::start_attempt(
            &recorder,
            core_api::InferenceContext {
                session_id: context().session_id,
                thread_id: context().thread_id,
                turn_id: context().turn_id,
                source_thread_sequence: 7,
                model: None,
                purpose: core_api::InferencePurpose::Agent,
            },
            &input
        )
        .is_none()
    );
    core_api::ExecutionDiagnostics::record_hook(
        &recorder,
        &context().session_id,
        &context().thread_id,
        None,
        "run",
        &core_api::HookRunEvidence {
            program: "off".into(),
            arguments: Vec::new(),
            directory: std::path::PathBuf::new(),
            input: input.instructions.unwrap(),
            stdout: String::new(),
            stderr: String::new(),
            exit_code: None,
            stdout_truncated: false,
            stderr_truncated: false,
        },
    );
    assert!(recorder.worker.get().is_none());
}

#[test]
fn reading_an_enabled_session_before_its_first_observation_is_not_a_storage_failure() {
    let root = crate::tests::temporary_root();
    let recorder = TraceRecorder::new(Some(root.clone()));
    recorder
        .start_attempt(context(), &request())
        .cancel("first session");
    assert_eq!(
        recorder.flush(std::time::Duration::from_secs(2)),
        FlushOutcome::Complete
    );
    let page = recorder
        .read(&SessionId::new("unobserved-session").unwrap(), 0, 500)
        .unwrap();
    assert_eq!(
        page.diagnostics.recording_status,
        RecordingStatus::Recording
    );
    assert!(page.diagnostics.events.is_empty());
    assert_eq!(page.diagnostics.pending_records, 0);
    drop(recorder);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn exhausted_event_budget_cannot_accumulate_unreferenced_body_files() {
    let root = crate::tests::temporary_root();
    let recorder = TraceRecorder::new(Some(root.clone()));
    let mut attempt = recorder.start_attempt(context(), &request());
    assert_eq!(
        recorder.flush(std::time::Duration::from_secs(2)),
        FlushOutcome::Complete
    );
    let writer = recorder
        .storage
        .writers
        .lock()
        .unwrap()
        .get(&context().session_id)
        .unwrap()
        .clone();
    let mut state = writer.lock().unwrap();
    state.event_bytes = MAX_CAPTURE_EVENT_BYTES;
    let files = fs::read_dir(state.directory.join("payloads"))
        .unwrap()
        .count();
    drop(state);
    for _ in 0..10 {
        attempt.prepared_request(&request());
    }
    attempt.cancel("limit");
    assert_eq!(
        recorder.flush(std::time::Duration::from_secs(2)),
        FlushOutcome::Complete
    );
    let state = writer.lock().unwrap();
    assert_eq!(
        fs::read_dir(state.directory.join("payloads"))
            .unwrap()
            .count(),
        files
    );
    assert!(state.manifest.dropped_records > 0);
    drop(state);
    drop(recorder);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn shutting_down_cannot_accept_unpersisted_late_observations() {
    let root = crate::tests::temporary_root();
    let recorder = Arc::new(TraceRecorder::new(Some(root.clone())));
    let attempts = (0..4)
        .map(|_| recorder.start_attempt(context(), &request()))
        .collect::<Vec<_>>();
    assert_eq!(
        recorder.flush(std::time::Duration::from_secs(2)),
        FlushOutcome::Complete
    );
    let barrier = Arc::new(std::sync::Barrier::new(5));
    let producers = attempts
        .into_iter()
        .map(|mut attempt| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                for _ in 0..100 {
                    attempt.prepared_request(&request());
                }
                attempt.cancel("late");
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    recorder.shutdown(std::time::Duration::from_secs(2));
    for producer in producers {
        producer.join().unwrap();
    }
    assert_eq!(
        recorder.shutdown(std::time::Duration::from_secs(2)),
        FlushOutcome::Complete
    );
    let page = recorder.read(&context().session_id, 0, 500).unwrap();
    assert_eq!(page.diagnostics.pending_records, 0);
    assert_eq!(
        page.diagnostics.recording_status,
        RecordingStatus::Unavailable
    );
    drop(recorder);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn blocked_storage_cannot_block_observers_and_queue_losses_remain_visible() {
    let root = crate::tests::temporary_root();
    let recorder = TraceRecorder::new(Some(root.clone()));
    let mut attempt = recorder.start_attempt(context(), &request());
    assert_eq!(
        recorder.flush(std::time::Duration::from_secs(2)),
        FlushOutcome::Complete
    );
    let writer = recorder
        .storage
        .writers
        .lock()
        .unwrap()
        .get(&context().session_id)
        .unwrap()
        .clone();
    let blocked_disk = writer.lock().unwrap();
    let (finished, completed) = std::sync::mpsc::channel();
    let producer = std::thread::spawn(move || {
        for _ in 0..crate::worker::MAX_QUEUE_RECORDS + 8 {
            attempt.prepared_request(&request());
        }
        attempt.cancel("cancel remains independent");
        finished.send(()).unwrap();
    });
    let produced = completed.recv_timeout(std::time::Duration::from_secs(2));
    let page = recorder.read(&context().session_id, 0, 500).unwrap();
    assert_eq!(
        page.diagnostics.recording_status,
        RecordingStatus::Incomplete
    );
    assert!(page.diagnostics.pending_records > 0);
    assert!(page.diagnostics.dropped_records > 0);
    assert!(matches!(
        recorder.flush(std::time::Duration::ZERO),
        FlushOutcome::TimedOut { .. }
    ));
    drop(blocked_disk);
    producer.join().unwrap();
    produced.expect("callbacks must finish while storage remains blocked");
    assert_eq!(
        recorder.flush(std::time::Duration::from_secs(2)),
        FlushOutcome::Complete
    );
    assert!(
        recorder
            .read(&context().session_id, 0, 500)
            .unwrap()
            .diagnostics
            .dropped_records
            > 0
    );
    drop(recorder);
    let reopened = TraceRecorder::new(Some(root.clone()));
    assert_eq!(
        reopened
            .read(&context().session_id, 0, 500)
            .unwrap()
            .diagnostics
            .recording_status,
        RecordingStatus::Incomplete
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn active_attempts_and_partial_buffers_share_the_profile_memory_budget() {
    let root = crate::tests::temporary_root();
    let recorder = TraceRecorder::new(Some(root.clone()));
    let attempts = (0..crate::worker::MAX_ACTIVE_ATTEMPTS + 1)
        .map(|_| recorder.start_attempt(context(), &request()))
        .collect::<Vec<_>>();
    assert!(attempts.iter().any(|attempt| attempt.active.is_none()));
    assert!(
        attempts
            .iter()
            .filter(|attempt| attempt.active.is_some())
            .count()
            <= crate::worker::MAX_ACTIVE_ATTEMPTS
    );
    drop(attempts);
    assert_eq!(
        recorder.flush(std::time::Duration::from_secs(2)),
        FlushOutcome::Complete
    );
    assert!(
        recorder
            .read(&context().session_id, 0, 500)
            .unwrap()
            .diagnostics
            .dropped_records
            > 0
    );
    drop(recorder);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retired_sessions_reject_late_callbacks_and_cleanup_their_owned_capture() {
    let root = crate::tests::temporary_root();
    let recorder = TraceRecorder::new(Some(root.clone()));
    let mut attempt = recorder.start_attempt(context(), &request());
    assert_eq!(
        recorder.flush(std::time::Duration::from_secs(2)),
        FlushOutcome::Complete
    );
    let capture = recorder
        .running_worker()
        .unwrap()
        .existing_capture(&context().session_id)
        .unwrap();
    let directory = recorder.storage.directory(&context().session_id).unwrap();
    recorder.remove_session(&context().session_id);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while capture.cleanup_pending.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
        std::thread::yield_now();
    }
    assert!(!capture.cleanup_pending.load(Ordering::Acquire));
    assert!(!directory.exists());
    attempt.prepared_request(&request());
    attempt.cancel("late");
    drop(attempt);
    assert_eq!(
        recorder.shutdown(std::time::Duration::from_secs(2)),
        FlushOutcome::Complete
    );
    assert!(!directory.exists());
    fs::remove_dir_all(root).unwrap();
}
