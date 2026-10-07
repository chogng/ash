use ash_code_mode_protocol::CODE_MODE_PROTOCOL_VERSION;
use ash_code_mode_protocol::ClientToHost;
use ash_code_mode_protocol::CodeModeLimits;
use ash_code_mode_protocol::CodeModeSessionId;
use ash_code_mode_protocol::ExecuteRequest;
use ash_code_mode_protocol::HostFrame;
use ash_code_mode_protocol::HostToClient;
use ash_code_mode_protocol::OutputItem;
use ash_code_mode_protocol::RuntimeResponse;
use ash_code_mode_protocol::WaitRequest;
use ash_code_mode_protocol::read_frame;
use std::collections::BTreeMap;
use std::io::BufReader;
use std::process::Command;
use std::process::Stdio;

struct Host {
    child: std::process::Child,
    writer: std::process::ChildStdin,
    events: std::sync::mpsc::Receiver<HostToClient>,
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Host {
    fn new() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_ash-code-mode-host"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let writer = child.stdin.take().unwrap();
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let (sender, events) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            while let Ok(message) = read_frame::<_, HostFrame<HostToClient>>(&mut reader) {
                if sender.send(message.message).is_err() {
                    break;
                }
            }
        });
        let mut host = Self {
            child,
            writer,
            events,
        };
        write_frame(
            &mut host.writer,
            &ClientToHost::Hello {
                protocol_version: CODE_MODE_PROTOCOL_VERSION,
            },
        )
        .unwrap();
        assert!(matches!(host.receive(), HostToClient::Hello { .. }));
        host
    }

    fn receive(&self) -> HostToClient {
        self.events
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("host response timed out")
    }

    fn open_session(&mut self, name: &str) -> CodeModeSessionId {
        let session_id = CodeModeSessionId::new(name).unwrap();
        write_frame(
            &mut self.writer,
            &ClientToHost::OpenSession {
                session_id: session_id.clone(),
                limits: CodeModeLimits {
                    max_execution_time_ms: 1000,
                    ..CodeModeLimits::default()
                },
                stored_values: BTreeMap::new(),
            },
        )
        .unwrap();
        assert!(matches!(self.receive(), HostToClient::SessionOpened { .. }));
        session_id
    }
}

#[test]
fn host_preserves_store_deletions_and_bounds_each_observation() {
    let mut host = Host::new();
    let session_id = host.open_session("host-test");
    for (index, source) in [
        "store('answer', 42); text('界'.repeat(100));",
        "store('answer', undefined); text('removed');",
        "text(load('answer') === undefined);",
    ]
    .iter()
    .enumerate()
    {
        write_frame(
            &mut host.writer,
            &ClientToHost::Execute(ExecuteRequest {
                session_id: session_id.clone(),
                tool_call_id: format!("exec-{index}"),
                source: (*source).into(),
                enabled_tools: Vec::new(),
                yield_time_ms: 1000,
                max_output_tokens: Some(32),
            }),
        )
        .unwrap();
        let HostToClient::StartedCell(started) = host.receive() else {
            panic!("expected started cell");
        };
        write_frame(
            &mut host.writer,
            &ClientToHost::Wait(WaitRequest {
                cell_id: started.cell_id.clone(),
                yield_time_ms: 1000,
                max_output_tokens: Some(32),
                terminate: false,
            }),
        )
        .unwrap();
        let mut received = false;
        loop {
            match host.receive() {
                HostToClient::CancelCellTools { cell_id } => {
                    assert_eq!(cell_id, started.cell_id);
                }
                HostToClient::StoreSnapshot { values, .. } => {
                    if index == 0 {
                        assert_eq!(values.get("answer"), Some(&serde_json::json!(42)));
                    } else {
                        assert!(values.is_empty());
                    }
                }
                HostToClient::Response {
                    response:
                        RuntimeResponse::Result {
                            content_items,
                            error_text,
                            ..
                        },
                } => {
                    assert_eq!(error_text, None);
                    assert!(
                        matches!(&content_items[..], [OutputItem::Text { text }] if text.len() <= 32)
                    );
                    if index == 0 {
                        assert!(
                            matches!(&content_items[0], OutputItem::Text { text } if text.contains("truncated"))
                        );
                    }
                    if index == 2 {
                        assert_eq!(
                            content_items,
                            vec![OutputItem::Text {
                                text: "true".into()
                            }]
                        );
                    }
                    received = true;
                }
                HostToClient::CellClosed { cell_id, .. } => {
                    assert_eq!(cell_id, started.cell_id);
                    assert!(received);
                    break;
                }
                other => panic!("unexpected host event: {other:?}"),
            }
        }
    }
    write_frame(
        &mut host.writer,
        &ClientToHost::Execute(ExecuteRequest {
            session_id: session_id.clone(),
            tool_call_id: "timeout".into(),
            source: "await tools.blocking({});".into(),
            enabled_tools: vec![ash_code_mode_protocol::EnabledTool {
                global_name: "blocking".into(),
                tool_name: "blocking".into(),
                description: "wait".into(),
                kind: ash_code_mode_protocol::CodeModeToolKind::Function,
                input_schema: serde_json::json!({"type": "object"}),
            }],
            yield_time_ms: 1,
            max_output_tokens: None,
        }),
    )
    .unwrap();
    let HostToClient::StartedCell(started) = host.receive() else {
        panic!("expected started cell");
    };
    write_frame(
        &mut host.writer,
        &ClientToHost::Wait(WaitRequest {
            cell_id: started.cell_id.clone(),
            yield_time_ms: 1,
            max_output_tokens: None,
            terminate: false,
        }),
    )
    .unwrap();
    // Never complete the tool and never send another wait. The host must cancel the
    // parent callback on timeout without requiring an observer to poll the cell.
    let mut invoked = None;
    loop {
        match host.receive() {
            HostToClient::ToolCall(call) => {
                assert_eq!(call.cell_id, started.cell_id);
                invoked = Some(call.runtime_tool_call_id);
            }
            HostToClient::CancelCellTools { cell_id } => {
                assert_eq!(cell_id, started.cell_id);
                assert!(invoked.is_some());
                break;
            }
            HostToClient::StoreSnapshot { .. }
            | HostToClient::Response {
                response: RuntimeResponse::Running { .. },
            } => {}
            other => panic!("unexpected event while awaiting cancellation: {other:?}"),
        }
    }
    // Cancellation races with a callback already returning from the parent. Its late
    // result must be discarded without poisoning other cells in this session.
    write_frame(
        &mut host.writer,
        &ClientToHost::CompleteToolCall {
            cell_id: started.cell_id,
            runtime_tool_call_id: invoked.unwrap(),
            result: serde_json::Value::Null,
            error_text: Some("cancelled".into()),
        },
    )
    .unwrap();
    write_frame(
        &mut host.writer,
        &ClientToHost::Execute(ExecuteRequest {
            session_id,
            tool_call_id: "after-cancel".into(),
            source: "text('alive');".into(),
            enabled_tools: Vec::new(),
            yield_time_ms: 1000,
            max_output_tokens: None,
        }),
    )
    .unwrap();
    assert!(matches!(host.receive(), HostToClient::StartedCell(_)));
}

#[test]
fn concurrent_cells_publish_monotonic_snapshots_and_complete_result_batches() {
    let mut host = Host::new();
    let session_id = host.open_session("concurrent-store");
    let mut previous = BTreeMap::new();
    for batch in 0..4 {
        let mut cells = std::collections::BTreeSet::new();
        for index in batch * 8..(batch + 1) * 8 {
            write_frame(
                &mut host.writer,
                &ClientToHost::Execute(ExecuteRequest {
                    session_id: session_id.clone(),
                    tool_call_id: format!("exec-{index}"),
                    source: format!("store('key-{index}', 'x'.repeat(4096));"),
                    enabled_tools: Vec::new(),
                    yield_time_ms: 1000,
                    max_output_tokens: None,
                }),
            )
            .unwrap();
            let HostToClient::StartedCell(started) = host.receive() else {
                panic!("expected started cell");
            };
            cells.insert(started.cell_id);
        }
        for cell_id in &cells {
            write_frame(
                &mut host.writer,
                &ClientToHost::Wait(WaitRequest {
                    cell_id: cell_id.clone(),
                    yield_time_ms: 1000,
                    max_output_tokens: None,
                    terminate: false,
                }),
            )
            .unwrap();
        }
        while !cells.is_empty() {
            match host.receive() {
                HostToClient::CancelCellTools { .. } => {}
                HostToClient::StoreSnapshot { values, .. } => {
                    for (key, value) in &previous {
                        assert_eq!(values.get(key), Some(value), "snapshot lost {key}");
                    }
                    previous = values;
                    let HostToClient::Response {
                        response:
                            RuntimeResponse::Result {
                                cell_id,
                                error_text: None,
                                ..
                            },
                    } = host.receive()
                    else {
                        panic!("snapshot and result must be adjacent");
                    };
                    assert!(cells.remove(&cell_id));
                    assert!(matches!(host.receive(), HostToClient::CellClosed {
                    cell_id: closed, outcome: ash_code_mode_protocol::CellOutcome::Completed,
                } if closed == cell_id));
                }
                other => panic!("unexpected event: {other:?}"),
            }
        }
    }
    assert_eq!(previous.len(), 32);
}

#[test]
fn exit_and_timeout_preserve_output_through_the_host() {
    let mut host = Host::new();
    let session_id = host.open_session("host-interrupts");
    for (index, source) in [
        "text('before'); try { exit(); } catch (_) { text('caught'); } finally { text('finally'); } throw Error('after');",
        "text('before'); while (true) {}",
    ].iter().enumerate() {
        write_frame(&mut host.writer, &ClientToHost::Execute(ExecuteRequest {
            session_id: session_id.clone(), tool_call_id: format!("exec-{index}"),
            source: (*source).into(), enabled_tools: Vec::new(),
            yield_time_ms: 2000, max_output_tokens: None,
        })).unwrap();
        let HostToClient::StartedCell(started) = host.receive() else { panic!("expected cell"); };
        write_frame(&mut host.writer, &ClientToHost::Wait(WaitRequest {
            cell_id: started.cell_id, yield_time_ms: 2000,
            max_output_tokens: None, terminate: false,
        })).unwrap();
        let mut received = false;
        loop {
            match host.receive() {
                HostToClient::CancelCellTools { .. } | HostToClient::StoreSnapshot { .. } => {}
                HostToClient::Response { response } => {
                    let items = match response {
                        RuntimeResponse::Result { content_items, error_text: None, .. } if index == 0 => content_items,
                        RuntimeResponse::Terminated { content_items, .. } if index == 1 => content_items,
                        other => panic!("unexpected response: {other:?}"),
                    };
                    assert_eq!(items, vec![OutputItem::Text { text: "before".into() }]);
                    received = true;
                }
                HostToClient::CellClosed { .. } => { assert!(received); break; }
                other => panic!("unexpected event: {other:?}"),
            }
        }
    }
}

fn write_frame<W: std::io::Write>(
    writer: &mut W,
    message: &ClientToHost,
) -> Result<(), ash_code_mode_protocol::ProtocolError> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let request_id = if matches!(message, ClientToHost::CompleteToolCall { .. }) {
        None
    } else {
        Some(NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
    };
    ash_code_mode_protocol::write_frame(
        writer,
        &HostFrame {
            request_id,
            message,
        },
    )
}
