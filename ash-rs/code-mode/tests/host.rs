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
fn silent_and_partial_handshakes_time_out_and_reap_the_host() {
    for mode in ["silent-host", "partial-host"] {
        let directory = std::env::temp_dir().join(format!(
            "ash-code-mode-{}-{}-{mode}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir(&directory).unwrap();
        let program = directory.join(format!("{mode}{}", std::env::consts::EXE_SUFFIX));
        std::fs::copy(env!("CARGO_BIN_EXE_ash-code-mode-fake-host"), &program).unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let child_program = program.clone();
        std::thread::spawn(move || {
            let result = CodeModeRuntime::new_host(
                child_program,
                CodeModeSessionId::new("handshake-test").unwrap(),
                CodeModeLimits::default(),
                Arc::new(NoTools),
                CodeModeStore::new(),
            );
            let _ = sender.send(result.err().map(|error| error.to_string()));
        });
        let error = receiver
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("host startup must be bounded")
            .expect("handshake should fail");
        assert!(error.contains("handshake timed out"), "{error}");
        let pid = std::fs::read_to_string(program.with_extension("pid")).unwrap();
        #[cfg(unix)]
        assert!(
            !std::process::Command::new("kill")
                .args(["-0", &pid])
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap()
                .success(),
            "host was not reaped"
        );
        #[cfg(not(unix))]
        let _ = pid;
        std::fs::remove_dir_all(directory).unwrap();
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
