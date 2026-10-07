use super::ExecEventSink;
use super::JsonLinesExecEventSink;
use crate::EXEC_EVENT_SCHEMA_VERSION;
use crate::ExecEvent;
use crate::ExecEventKind;
use crate::ExecOrigin;
use crate::ExecRunId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;

#[test]
fn json_lines_sink_writes_one_complete_event_per_line() {
    let event = ExecEvent::new(
        &ExecRunId::new("run-jsonl").unwrap(),
        ExecEventKind::RunStarted {
            origin: ExecOrigin::Local,
            session_id: SessionId::new("session-jsonl").unwrap(),
            thread_id: ThreadId::new("thread-jsonl").unwrap(),
        },
    );
    let mut sink = JsonLinesExecEventSink::new(Vec::new());
    sink.emit(&event).unwrap();
    let output = String::from_utf8(sink.into_inner()).unwrap();
    assert_eq!(output.lines().count(), 1);
    let value: serde_json::Value = serde_json::from_str(output.trim_end()).unwrap();
    assert_eq!(value["schemaVersion"], EXEC_EVENT_SCHEMA_VERSION);
}
