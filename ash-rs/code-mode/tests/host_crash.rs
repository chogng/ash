use ash_code_mode::{CodeModeRuntime, CodeModeStore, ToolInvoker};
use ash_code_mode_protocol::{
    CodeModeLimits, CodeModeSessionId, ExecuteRequest, NestedToolCall, RuntimeResponse,
    WaitOutcome, WaitRequest,
};
use std::sync::Arc;

struct NoTools;

impl ToolInvoker for NoTools {
    fn invoke(&self, _: NestedToolCall) -> Result<serde_json::Value, String> {
        Err("unexpected tool call".into())
    }
}

#[test]
fn host_eof_marks_the_cell_unknown_without_restarting_it() {
    let session_id = CodeModeSessionId::new("host-crash-session").unwrap();
    let runtime = CodeModeRuntime::new_host(
        env!("CARGO_BIN_EXE_ash-code-mode-fake-host").into(),
        session_id.clone(),
        CodeModeLimits::default(),
        Arc::new(NoTools),
        CodeModeStore::new(),
    )
    .unwrap();
    let started = runtime
        .execute(ExecuteRequest {
            session_id,
            tool_call_id: "outer-call".into(),
            source: "text('never returned')".into(),
            enabled_tools: Vec::new(),
            yield_time_ms: 100,
            max_output_tokens: None,
        })
        .unwrap();

    {
        let WaitOutcome::LiveCell { response } = runtime
            .wait(WaitRequest {
                cell_id: started.cell_id.clone(),
                yield_time_ms: 100,
                max_output_tokens: None,
                terminate: false,
            })
            .unwrap()
        else {
            panic!("cell disappeared after Host EOF");
        };
        assert!(matches!(response, RuntimeResponse::Unknown { .. }));
    }
    assert!(matches!(
        runtime
            .wait(WaitRequest {
                cell_id: started.cell_id,
                yield_time_ms: 0,
                max_output_tokens: None,
                terminate: false,
            })
            .unwrap(),
        WaitOutcome::MissingCell { .. }
    ));
}
