use ash_code_mode::{CodeModeHost, ToolInvoker};
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
            let id = CodeModeSessionId::new("handshake-test").unwrap();
            let session = CodeModeHost::with_program(child_program)
                .session(id.clone(), CodeModeLimits::default());
            let result = session.execute(request(id), Arc::new(NoTools));
            let _ = sender.send(result.err().map(|error| error.to_string()));
        });
        let error = receiver
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("host startup must be bounded")
            .expect("handshake should fail");
        assert!(error.contains("request timed out"), "{error}");
        let pid = std::fs::read_to_string(program.with_extension("pid")).unwrap();
        assert_process_exited(pid.trim());
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn host_eof_marks_the_cell_unknown_without_restarting_it() {
    let session_id = CodeModeSessionId::new("host-crash-session").unwrap();
    let host = CodeModeHost::with_program(env!("CARGO_BIN_EXE_ash-code-mode-fake-host").into());
    let runtime = host.session(session_id.clone(), CodeModeLimits::default());
    let started = runtime
        .execute(
            ExecuteRequest {
                session_id: session_id.clone(),
                tool_call_id: "outer-call".into(),
                source: "text('never returned')".into(),
                enabled_tools: Vec::new(),
                yield_time_ms: 100,
                max_output_tokens: None,
            },
            Arc::new(NoTools),
        )
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
                cell_id: started.cell_id.clone(),
                yield_time_ms: 0,
                max_output_tokens: None,
                terminate: false,
            })
            .unwrap(),
        WaitOutcome::MissingCell { .. }
    ));
    let next = runtime
        .execute(request(session_id), Arc::new(NoTools))
        .unwrap();
    assert_ne!(next.cell_id, started.cell_id);
    assert!(!runtime.has_cell(&started.cell_id));
}

fn request(session_id: CodeModeSessionId) -> ExecuteRequest {
    ExecuteRequest {
        session_id,
        tool_call_id: "call".into(),
        source: "text(1)".into(),
        enabled_tools: Vec::new(),
        yield_time_ms: 100,
        max_output_tokens: None,
    }
}

#[test]
fn provider_is_lazy_and_reuses_one_process_across_session_close() {
    let directory = std::env::temp_dir().join(format!(
        "ash-shared-host-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&directory).unwrap();
    let program = directory.join(format!("recording-host{}", std::env::consts::EXE_SUFFIX));
    std::fs::copy(env!("CARGO_BIN_EXE_ash-code-mode-fake-host"), &program).unwrap();
    let host = CodeModeHost::with_program(program.clone());
    assert!(!program.with_extension("starts").exists());
    for name in ["first", "second"] {
        let id = CodeModeSessionId::new(name).unwrap();
        let session = host.session(id.clone(), CodeModeLimits::default());
        session.execute(request(id), Arc::new(NoTools)).unwrap();
        session.close();
    }
    let starts = std::fs::read_to_string(program.with_extension("starts")).unwrap();
    assert_eq!(
        starts.lines().count(),
        1,
        "closing a session must not restart the Host"
    );
    drop(host);
    assert_process_exited(starts.trim());
    std::fs::remove_dir_all(directory).unwrap();
}

fn assert_process_exited(pid: &str) {
    #[cfg(windows)]
    {
        let output = std::process::Command::new("tasklist.exe")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(
            !String::from_utf8_lossy(&output.stdout).contains(&format!(",\"{pid}\",")),
            "Host process was not reaped"
        );
    }
    #[cfg(unix)]
    assert!(
        !std::process::Command::new("kill")
            .args(["-0", pid])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    );
}

#[test]
fn recovery_imports_the_latest_valid_snapshot_and_keeps_deletions() {
    let id = CodeModeSessionId::new("recovery").unwrap();
    let host = CodeModeHost::with_program(env!("CARGO_BIN_EXE_ash-code-mode-fake-host").into());
    let session = host.session(id.clone(), CodeModeLimits::default());
    let execute = |source: &str| {
        let mut request = request(id.clone());
        request.source = source.into();
        let started = session.execute(request, Arc::new(NoTools)).unwrap();
        let outcome = session
            .wait(WaitRequest {
                cell_id: started.cell_id,
                yield_time_ms: 1000,
                max_output_tokens: None,
                terminate: false,
            })
            .unwrap();
        match outcome {
            WaitOutcome::LiveCell { response } => response,
            other => panic!("unexpected outcome: {other:?}"),
        }
    };
    let values = |response| {
        let RuntimeResponse::Result {
            content_items,
            error_text: None,
            ..
        } = response
        else {
            panic!("expected completed snapshot request");
        };
        let [ash_code_mode_protocol::OutputItem::Text { text }] = content_items.as_slice() else {
            panic!("expected snapshot output");
        };
        serde_json::from_str::<serde_json::Value>(text).unwrap()
    };

    assert_eq!(
        values(execute("snapshot")),
        serde_json::json!({"answer":42, "deleted":true})
    );
    assert_eq!(values(execute("delete")), serde_json::json!({"answer":42}));
    assert!(matches!(execute("crash"), RuntimeResponse::Unknown { .. }));
    assert_eq!(values(execute("inspect")), serde_json::json!({"answer":42}));
    assert!(
        matches!(execute("oversized"), RuntimeResponse::Unknown { reason, .. }
        if reason.contains("Code Mode store exceeds"))
    );
    assert_eq!(values(execute("inspect")), serde_json::json!({"answer":42}));
}
