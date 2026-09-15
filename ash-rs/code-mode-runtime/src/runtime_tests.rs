use super::*;
use ash_code_mode_protocol::{
    CellId, CodeModeLimits, CodeModeSessionId, CodeModeToolKind, EnabledTool, ExecuteRequest,
    NestedToolCall, OutputItem, RuntimeNotification, RuntimeResponse, WaitOutcome, WaitRequest,
};
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

#[derive(Default)]
struct RecordingInvoker {
    calls: Mutex<Vec<NestedToolCall>>,
}

impl ToolInvoker for RecordingInvoker {
    fn invoke(&self, call: NestedToolCall) -> Result<serde_json::Value, String> {
        self.calls.lock().unwrap().push(call);
        Ok(serde_json::json!({"value": "from-tool"}))
    }

    fn notify(&self, _: RuntimeNotification) -> Result<(), String> {
        Ok(())
    }
}

fn request(session_id: &CodeModeSessionId, source: &str) -> ExecuteRequest {
    ExecuteRequest {
        session_id: session_id.clone(),
        tool_call_id: "outer-call".into(),
        source: source.into(),
        enabled_tools: vec![EnabledTool {
            global_name: "echo".into(),
            tool_name: "echo_tool".into(),
            description: "Echoes an object".into(),
            kind: CodeModeToolKind::Function,
            input_schema: serde_json::json!({"type": "object"}),
        }],
        yield_time_ms: 1_000,
        max_output_tokens: None,
    }
}

fn runtime(invoker: &std::sync::Arc<RecordingInvoker>) -> (CodeModeRuntime, CodeModeSessionId) {
    let session_id = CodeModeSessionId::new("session-1").unwrap();
    let runtime = CodeModeRuntime::new(
        session_id.clone(),
        CodeModeLimits {
            max_execution_time_ms: 5_000,
            ..CodeModeLimits::default()
        },
        invoker.clone(),
    )
    .unwrap();
    (runtime, session_id)
}

fn wait_for_result(runtime: &CodeModeRuntime, cell_id: CellId) -> RuntimeResponse {
    for _ in 0..10 {
        let outcome = runtime
            .wait(WaitRequest {
                cell_id: cell_id.clone(),
                yield_time_ms: 1_000,
                max_output_tokens: None,
                terminate: false,
            })
            .unwrap();
        let WaitOutcome::LiveCell { response } = outcome else {
            panic!("cell disappeared");
        };
        if matches!(
            response,
            RuntimeResponse::Result { .. }
                | RuntimeResponse::Terminated { .. }
                | RuntimeResponse::Unknown { .. }
        ) {
            return response;
        }
    }
    panic!("cell did not finish")
}

#[test]
fn executes_javascript_and_keeps_store_in_the_session() {
    let invoker = std::sync::Arc::new(RecordingInvoker::default());
    let (runtime, session_id) = runtime(&invoker);
    let started = runtime
        .execute(request(
            &session_id,
            r#"store("answer", {"value": 42}); text(load("answer"));"#,
        ))
        .unwrap();
    let RuntimeResponse::Result { content_items, .. } = wait_for_result(&runtime, started.cell_id)
    else {
        panic!("expected result");
    };
    assert_eq!(
        content_items,
        vec![OutputItem::Text {
            text: r#"{"value":42}"#.into(),
        }]
    );
}

#[test]
fn store_is_shared_by_runtimes_in_one_thread_session() {
    let invoker = std::sync::Arc::new(RecordingInvoker::default());
    let session_id = CodeModeSessionId::new("shared-session").unwrap();
    let store = CodeModeStore::new();
    let first_runtime = CodeModeRuntime::new_with_store(
        session_id.clone(),
        CodeModeLimits::default(),
        invoker.clone(),
        store.clone(),
    )
    .unwrap();
    let first = first_runtime
        .execute(request(&session_id, r#"store("answer", 42);"#))
        .unwrap();
    assert!(matches!(
        wait_for_result(&first_runtime, first.cell_id),
        RuntimeResponse::Result {
            error_text: None,
            ..
        }
    ));
    drop(first_runtime);

    let second_runtime = CodeModeRuntime::new_with_store(
        session_id.clone(),
        CodeModeLimits::default(),
        invoker,
        store,
    )
    .unwrap();
    let second = second_runtime
        .execute(request(&session_id, r#"text(load("answer"));"#))
        .unwrap();
    let RuntimeResponse::Result { content_items, .. } =
        wait_for_result(&second_runtime, second.cell_id)
    else {
        panic!("expected result");
    };
    assert_eq!(content_items, vec![OutputItem::Text { text: "42".into() }]);
}

#[test]
fn invokes_only_projected_tools() {
    let invoker = std::sync::Arc::new(RecordingInvoker::default());
    let (runtime, session_id) = runtime(&invoker);
    let started = runtime
        .execute(request(
            &session_id,
            r#"const value = await tools.echo({"input": true}); text(value.value);"#,
        ))
        .unwrap();
    let response = wait_for_result(&runtime, started.cell_id);
    assert!(matches!(
        response,
        RuntimeResponse::Result {
            error_text: None,
            ..
        }
    ));
    let calls = invoker.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].global_name, "echo");
    assert_eq!(calls[0].input, serde_json::json!({"input": true}));
}

struct ConcurrentInvoker {
    active: AtomicUsize,
    maximum_active: AtomicUsize,
    gate: (Mutex<()>, Condvar),
}

impl ConcurrentInvoker {
    fn new() -> Self {
        Self {
            active: AtomicUsize::new(0),
            maximum_active: AtomicUsize::new(0),
            gate: (Mutex::new(()), Condvar::new()),
        }
    }
}

impl ToolInvoker for ConcurrentInvoker {
    fn invoke(&self, _: NestedToolCall) -> Result<serde_json::Value, String> {
        let active = self.active.fetch_add(1, Ordering::AcqRel) + 1;
        self.maximum_active.fetch_max(active, Ordering::AcqRel);
        self.gate.1.notify_all();
        let guard = self.gate.0.lock().unwrap();
        let _ = self
            .gate
            .1
            .wait_timeout_while(guard, Duration::from_millis(500), |_| {
                self.active.load(Ordering::Acquire) < 2
            })
            .unwrap();
        self.active.fetch_sub(1, Ordering::AcqRel);
        Ok(serde_json::json!({"value": "from-tool"}))
    }
}

#[test]
fn projected_tools_can_execute_concurrently() {
    let invoker = std::sync::Arc::new(ConcurrentInvoker::new());
    let session_id = CodeModeSessionId::new("concurrent-session").unwrap();
    let runtime = CodeModeRuntime::new(
        session_id.clone(),
        CodeModeLimits {
            max_execution_time_ms: 5_000,
            ..CodeModeLimits::default()
        },
        invoker.clone(),
    )
    .unwrap();
    let started = runtime
        .execute(request(
            &session_id,
            r#"await Promise.all([tools.echo({"id": 1}), tools.echo({"id": 2})]);"#,
        ))
        .unwrap();
    assert!(matches!(
        wait_for_result(&runtime, started.cell_id),
        RuntimeResponse::Result {
            error_text: None,
            ..
        }
    ));
    assert_eq!(invoker.maximum_active.load(Ordering::Acquire), 2);
}

#[test]
fn yield_is_pause_and_wait_resumes_the_same_cell() {
    let invoker = std::sync::Arc::new(RecordingInvoker::default());
    let (runtime, session_id) = runtime(&invoker);
    let started = runtime
        .execute(request(
            &session_id,
            r#"text("before"); await yield_control(); text("after");"#,
        ))
        .unwrap();
    let first = runtime.wait(WaitRequest {
        cell_id: started.cell_id.clone(),
        yield_time_ms: 1_000,
        max_output_tokens: None,
        terminate: false,
    });
    assert!(matches!(
        first.unwrap(),
        WaitOutcome::LiveCell {
            response: RuntimeResponse::Yielded { .. }
        }
    ));
    let RuntimeResponse::Result { content_items, .. } = wait_for_result(&runtime, started.cell_id)
    else {
        panic!("expected resumed result");
    };
    assert_eq!(
        content_items,
        vec![OutputItem::Text {
            text: "after".into(),
        }]
    );
}

#[test]
fn syntax_errors_are_cell_failures_and_not_process_failures() {
    let invoker = std::sync::Arc::new(RecordingInvoker::default());
    let (runtime, session_id) = runtime(&invoker);
    let started = runtime
        .execute(request(&session_id, "not valid javascript ("))
        .unwrap();
    let RuntimeResponse::Result { error_text, .. } = wait_for_result(&runtime, started.cell_id)
    else {
        panic!("expected failed result");
    };
    assert!(error_text.is_some());
}

#[test]
fn output_limit_is_enforced_inside_the_runtime() {
    let invoker = std::sync::Arc::new(RecordingInvoker::default());
    let session_id = CodeModeSessionId::new("limited-session").unwrap();
    let runtime = CodeModeRuntime::new(
        session_id.clone(),
        CodeModeLimits {
            max_output_bytes: 8,
            max_execution_time_ms: 5_000,
            ..CodeModeLimits::default()
        },
        invoker,
    )
    .unwrap();
    let started = runtime
        .execute(request(&session_id, "text('this output is too large');"))
        .unwrap();
    let RuntimeResponse::Result { error_text, .. } = wait_for_result(&runtime, started.cell_id)
    else {
        panic!("expected output-limit failure");
    };
    assert!(error_text.unwrap().contains("output"));
}

#[test]
fn execution_timeout_terminates_cpu_bound_javascript() {
    let invoker = std::sync::Arc::new(RecordingInvoker::default());
    let session_id = CodeModeSessionId::new("timeout-session").unwrap();
    let runtime = CodeModeRuntime::new(
        session_id.clone(),
        CodeModeLimits {
            max_execution_time_ms: 20,
            ..CodeModeLimits::default()
        },
        invoker,
    )
    .unwrap();
    let started = runtime
        .execute(request(&session_id, "while (true) {}"))
        .unwrap();
    let response = wait_for_result(&runtime, started.cell_id);
    assert!(
        matches!(response, RuntimeResponse::Terminated { .. }),
        "response: {response:?}"
    );
}

#[test]
fn heap_limit_fails_the_cell_without_crashing_the_process() {
    let invoker = std::sync::Arc::new(RecordingInvoker::default());
    let session_id = CodeModeSessionId::new("heap-limited-session").unwrap();
    let runtime = CodeModeRuntime::new(
        session_id.clone(),
        CodeModeLimits {
            max_heap_bytes: 16 * 1024 * 1024,
            max_execution_time_ms: 5_000,
            ..CodeModeLimits::default()
        },
        invoker,
    )
    .unwrap();
    let started = runtime
        .execute(request(
            &session_id,
            "const values = []; while (true) { values.push('x'.repeat(1024)); }",
        ))
        .unwrap();
    let RuntimeResponse::Result { error_text, .. } = wait_for_result(&runtime, started.cell_id)
    else {
        panic!("expected memory-limit failure");
    };
    assert!(error_text.unwrap().contains("memory limit"));
}
