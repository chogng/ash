use ash_code_mode_protocol::CODE_MODE_PROTOCOL_VERSION;
use ash_code_mode_protocol::ClientToHost;
use ash_code_mode_protocol::CodeModeLimits;
use ash_code_mode_protocol::CodeModeSessionId;
use ash_code_mode_protocol::ExecuteRequest;
use ash_code_mode_protocol::HostToClient;
use ash_code_mode_protocol::OutputItem;
use ash_code_mode_protocol::RuntimeResponse;
use ash_code_mode_protocol::WaitRequest;
use ash_code_mode_protocol::read_frame;
use ash_code_mode_protocol::write_frame;
use std::collections::BTreeMap;
use std::io::BufReader;
use std::process::Command;
use std::process::Stdio;

struct Host(std::process::Child);

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn host_preserves_store_deletions_and_bounds_each_observation() {
    let mut host = Host(
        Command::new(env!("CARGO_BIN_EXE_ash-code-mode-host"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let mut writer = host.0.stdin.take().unwrap();
    let mut reader = BufReader::new(host.0.stdout.take().unwrap());
    let (sender, events) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        while let Ok(message) = read_frame::<_, HostToClient>(&mut reader) {
            if sender.send(message).is_err() {
                break;
            }
        }
    });
    let receive = || {
        events
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("host response timed out")
    };
    write_frame(
        &mut writer,
        &ClientToHost::Hello {
            protocol_version: CODE_MODE_PROTOCOL_VERSION,
        },
    )
    .unwrap();
    assert!(matches!(receive(), HostToClient::Hello { .. }));
    let session_id = CodeModeSessionId::new("host-test").unwrap();
    write_frame(
        &mut writer,
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
    assert!(matches!(receive(), HostToClient::SessionOpened { .. }));
    for (index, source) in [
        "store('answer', 42); text('界'.repeat(100));",
        "store('answer', undefined); text('removed');",
        "text(load('answer') === undefined);",
    ]
    .iter()
    .enumerate()
    {
        write_frame(
            &mut writer,
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
        let HostToClient::StartedCell(started) = receive() else {
            panic!("expected started cell");
        };
        write_frame(
            &mut writer,
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
            match receive() {
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
        &mut writer,
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
    let HostToClient::StartedCell(started) = receive() else {
        panic!("expected started cell");
    };
    write_frame(
        &mut writer,
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
        match receive() {
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
        &mut writer,
        &ClientToHost::CompleteToolCall {
            cell_id: started.cell_id,
            runtime_tool_call_id: invoked.unwrap(),
            result: serde_json::Value::Null,
            error_text: Some("cancelled".into()),
        },
    )
    .unwrap();
    write_frame(
        &mut writer,
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
    assert!(matches!(receive(), HostToClient::StartedCell(_)));
}
