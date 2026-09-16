use ash_code_mode::CodeModeRuntime;
use ash_code_mode::CodeModeStore;
use ash_code_mode::ToolInvoker;
use ash_code_mode_protocol::CodeModeLimits;
use ash_code_mode_protocol::CodeModeSessionId;
use ash_code_mode_protocol::CodeModeToolKind;
use ash_code_mode_protocol::EnabledTool;
use ash_code_mode_protocol::ExecuteRequest;
use ash_code_mode_protocol::NestedToolCall;
use ash_code_mode_protocol::OutputItem;
use ash_code_mode_protocol::RuntimeResponse;
use ash_code_mode_protocol::WaitOutcome;
use ash_code_mode_protocol::WaitRequest;
use std::process::Command;
use std::sync::Arc;
use std::sync::Mutex;

#[derive(Default)]
struct Invoker {
    calls: Mutex<Vec<NestedToolCall>>,
}

impl ToolInvoker for Invoker {
    fn invoke(&self, call: NestedToolCall) -> Result<serde_json::Value, String> {
        self.calls.lock().unwrap().push(call);
        Ok(serde_json::json!(42))
    }
}

#[test]
fn default_client_uses_host_for_tools_and_shared_values() {
    if std::env::var_os("ASH_HOST_CLIENT_TEST").is_none() {
        let result = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "default_client_uses_host_for_tools_and_shared_values",
                "--nocapture",
            ])
            .env("ASH_HOST_CLIENT_TEST", "1")
            .env(
                "ASH_CODE_MODE_HOST_BIN",
                env!("CARGO_BIN_EXE_ash-code-mode-host"),
            )
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        return;
    }

    let session_id = CodeModeSessionId::new("host-client").unwrap();
    let invoker = Arc::new(Invoker::default());
    let store = CodeModeStore::new();
    for (index, source) in [
        "store('answer', await tools.echo({input: true})); text(load('answer'));",
        "text(load('answer')); store('answer', undefined);",
    ]
    .into_iter()
    .enumerate()
    {
        let runtime = CodeModeRuntime::new_with_store(
            session_id.clone(),
            CodeModeLimits::default(),
            invoker.clone(),
            store.clone(),
        )
        .unwrap();
        let cell = runtime
            .execute(ExecuteRequest {
                session_id: session_id.clone(),
                tool_call_id: format!("call-{index}"),
                source: source.into(),
                enabled_tools: vec![EnabledTool {
                    global_name: "echo".into(),
                    tool_name: "echo_tool".into(),
                    description: "Returns the answer".into(),
                    kind: CodeModeToolKind::Function,
                    input_schema: serde_json::json!({"type": "object"}),
                }],
                yield_time_ms: 1000,
                max_output_tokens: None,
            })
            .unwrap();
        let mut completed = false;
        for _ in 0..10 {
            let result = runtime
                .wait(WaitRequest {
                    cell_id: cell.cell_id.clone(),
                    yield_time_ms: 1000,
                    max_output_tokens: None,
                    terminate: false,
                })
                .unwrap();
            if let WaitOutcome::LiveCell {
                response:
                    RuntimeResponse::Result {
                        content_items,
                        error_text,
                        ..
                    },
            } = result
            {
                assert_eq!(error_text, None);
                assert_eq!(content_items, vec![OutputItem::Text { text: "42".into() }]);
                completed = true;
                break;
            }
        }
        assert!(completed, "Host did not complete the cell");
        let values = store.snapshot().unwrap();
        if index == 0 {
            assert_eq!(values.get("answer"), Some(&serde_json::json!(42)));
        } else {
            assert!(values.is_empty());
        }
        runtime.close();
    }
    let calls = invoker.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].input, serde_json::json!({"input": true}));
}

#[test]
fn default_client_reports_a_missing_host_instead_of_running_in_process() {
    if std::env::var_os("ASH_MISSING_HOST_TEST").is_none() {
        let result = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "default_client_reports_a_missing_host_instead_of_running_in_process",
                "--nocapture",
            ])
            .env("ASH_MISSING_HOST_TEST", "1")
            .env(
                "ASH_CODE_MODE_HOST_BIN",
                std::path::Path::new(env!("CARGO_BIN_EXE_ash-code-mode-host")).join("missing-host"),
            )
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        return;
    }
    let result = CodeModeRuntime::new(
        CodeModeSessionId::new("missing-host").unwrap(),
        CodeModeLimits::default(),
        Arc::new(Invoker::default()),
    );
    let error = result
        .err()
        .expect("A missing Host must fail initialization");
    assert!(error.to_string().contains("failed to start Code Mode Host"));
}
