use super::*;
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
        serde_json::json!({ "text": "partial text", "reasoning": "partial reasoning", "truncated": false })
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
