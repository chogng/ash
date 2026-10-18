use super::*;
use crate::DiagnosticEvent;
use crate::DiagnosticEventKind;
use crate::DiagnosticTrace;
use crate::PayloadKind;
use crate::PayloadRef;
use crate::ThreadRolloutTrace;
use std::collections::VecDeque;

struct Source {
    traces: VecDeque<TracePage>,
    diagnostics: VecDeque<DiagnosticPage>,
    requested_payloads: Vec<String>,
    missing: bool,
}

impl TraceExportSource for Source {
    type Error = String;

    fn trace_page(
        &mut self,
        _: &SessionId,
        _: BTreeMap<ThreadId, u64>,
    ) -> Result<TracePage, String> {
        Ok(self.traces.pop_front().unwrap())
    }
    fn diagnostic_page(&mut self, _: &SessionId, _: u64) -> Result<DiagnosticPage, String> {
        Ok(self.diagnostics.pop_front().unwrap())
    }
    fn payload(
        &mut self,
        _: &SessionId,
        capture_id: &str,
        payload_id: &str,
    ) -> Result<Value, String> {
        assert_eq!(capture_id, "capture");
        self.requested_payloads.push(payload_id.into());
        if self.missing {
            Err("missing evidence".into())
        } else {
            Ok(serde_json::json!({"hook": "evidence"}))
        }
    }
}

fn source(status: PayloadStatus, missing: bool) -> Source {
    let thread_id = ThreadId::new("thread").unwrap();
    let trace = RolloutTrace {
        format_version: crate::ROLLOUT_TRACE_FORMAT_VERSION,
        session_id: SessionId::new("session").unwrap(),
        threads: vec![ThreadRolloutTrace {
            thread_id: thread_id.clone(),
            events: Vec::new(),
        }],
        history_prefixes: Vec::new(),
        diagnostics: None,
        graph: None,
        overview: None,
    };
    let diagnostics = DiagnosticTrace {
        format_version: crate::DIAGNOSTIC_TRACE_FORMAT_VERSION,
        capture_id: Some("capture".into()),
        recording_status: RecordingStatus::Recording,
        dropped_records: 0,
        pending_records: 0,
        payloads: BTreeMap::new(),
        events: vec![DiagnosticEvent {
            event_id: "event-1".into(),
            sequence: 1,
            recorded_at: 0,
            thread_id,
            turn_id: None,
            event: DiagnosticEventKind::HookRunRecorded {
                run_id: "hook-1".into(),
                execution_payload: PayloadRef {
                    payload_id: "payload-1".into(),
                    kind: PayloadKind::HookExecution,
                    byte_length: 1,
                    status,
                    digest: None,
                },
            },
        }],
    };
    Source {
        traces: VecDeque::from([TracePage {
            trace,
            cursors: BTreeMap::new(),
            has_more: false,
        }]),
        diagnostics: VecDeque::from([DiagnosticPage {
            diagnostics,
            cursor: 1,
            has_more: false,
        }]),
        requested_payloads: Vec::new(),
        missing,
    }
}

#[test]
fn export_embeds_hook_evidence_and_builds_its_graph_from_the_capture() {
    let mut source = source(PayloadStatus::Saved, false);
    let trace = export_session_trace(&mut source, &SessionId::new("session").unwrap()).unwrap();
    assert_eq!(source.requested_payloads, ["payload-1"]);
    let diagnostics = trace.diagnostics.unwrap();
    assert_eq!(
        diagnostics.payloads["payload-1"],
        serde_json::json!({"hook": "evidence"})
    );
    assert_eq!(diagnostics.recording_status, RecordingStatus::Recording);
    assert!(trace.graph.is_some());
}

#[test]
fn missing_or_omitted_evidence_preserves_events_and_marks_export_incomplete() {
    for (status, missing) in [
        (PayloadStatus::Saved, true),
        (PayloadStatus::Omitted, false),
    ] {
        let mut source = source(status, missing);
        let trace = export_session_trace(&mut source, &SessionId::new("session").unwrap()).unwrap();
        let diagnostics = trace.diagnostics.unwrap();
        assert_eq!(diagnostics.events.len(), 1);
        assert!(diagnostics.payloads.is_empty());
        assert_eq!(diagnostics.recording_status, RecordingStatus::Incomplete);
        assert!(!trace.graph.unwrap().warnings.is_empty());
    }
}

#[test]
fn export_accumulates_pages_and_fetches_each_payload_once() {
    let mut source = source(PayloadStatus::Saved, false);
    let prefix = history_prefix("earlier");
    let child_prefix = history_prefix("child-prefix");
    source.traces[0].trace.history_prefixes.push(prefix.clone());
    source.traces[0].has_more = true;
    let mut second = source.traces[0].trace.clone();
    second.history_prefixes.push(child_prefix.clone());
    second.threads.push(ThreadRolloutTrace {
        thread_id: ThreadId::new("child").unwrap(),
        events: Vec::new(),
    });
    source.traces.push_back(TracePage {
        trace: second,
        cursors: BTreeMap::new(),
        has_more: false,
    });
    source.diagnostics[0].has_more = true;
    let mut second = source.diagnostics[0].diagnostics.clone();
    second.events[0].sequence = 2;
    second.events[0].event_id = "event-2".into();
    source.diagnostics.push_back(DiagnosticPage {
        diagnostics: second,
        cursor: 2,
        has_more: false,
    });
    let trace = export_session_trace(&mut source, &SessionId::new("session").unwrap()).unwrap();
    assert_eq!(trace.threads.len(), 2);
    assert_eq!(trace.history_prefixes, [prefix, child_prefix]);
    assert_eq!(trace.diagnostics.unwrap().events.len(), 2);
    assert_eq!(source.requested_payloads, ["payload-1"]);
}

fn history_prefix(id: &str) -> ash_history::HistoryPrefix {
    let thread_id = ThreadId::new(id).unwrap();
    let prefix = ash_history::HistoryPrefix {
        events: vec![ash_history::StoredEvent {
            time_context: None,
            schema_version: ash_history::CURRENT_STORED_EVENT_SCHEMA_VERSION,
            event_id: ash_history::EventId(format!("{id}-1")),
            sequence: 1,
            thread_id: thread_id.clone(),
            recorded_at: ash_history::Timestamp(0),
            command: None,
            event: ash_protocol::ThreadEvent::ThreadCreated {
                agent_id: Some(ash_protocol::AgentId::new(format!("agent-{id}")).unwrap()),
                origin: Default::default(),
                agent: None,
                session_id: SessionId::new("session").unwrap(),
                thread_id,
                title: id.into(),
                execution_target: None,
            },
        }],
    };
    prefix.reference().unwrap();
    prefix
}

#[test]
fn export_rejects_diagnostic_pages_from_a_replacement_capture() {
    let mut source = source(PayloadStatus::Saved, false);
    source.diagnostics[0].has_more = true;
    let mut replacement = source.diagnostics[0].diagnostics.clone();
    replacement.capture_id = Some("replacement".into());
    source.diagnostics.push_back(DiagnosticPage {
        diagnostics: replacement,
        cursor: 2,
        has_more: false,
    });
    assert!(matches!(
        export_session_trace(&mut source, &SessionId::new("session").unwrap()),
        Err(TraceExportError::CaptureChanged)
    ));
}
