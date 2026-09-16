use ash_code_mode::CodeModeHost;
use ash_code_mode::CodeModeSession;
use ash_code_mode::ToolInvoker;
use ash_code_mode_protocol::CellId;
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
use std::sync::Arc;
use std::sync::Mutex;

struct Invoker {
    answer: i64,
    calls: Mutex<Vec<NestedToolCall>>,
    cancelled: Mutex<Vec<CellId>>,
}

impl Invoker {
    fn new(answer: i64) -> Arc<Self> {
        Arc::new(Self {
            answer,
            calls: Mutex::new(vec![]),
            cancelled: Mutex::new(vec![]),
        })
    }
}

impl ToolInvoker for Invoker {
    fn invoke(&self, call: NestedToolCall) -> Result<serde_json::Value, String> {
        self.calls.lock().unwrap().push(call);
        Ok(serde_json::json!(self.answer))
    }
    fn cancel_cell(&self, id: &CellId) {
        self.cancelled.lock().unwrap().push(id.clone());
    }
}

fn host() -> CodeModeHost {
    CodeModeHost::with_program(env!("CARGO_BIN_EXE_ash-code-mode-host").into())
}

fn request(id: &CodeModeSessionId, source: &str) -> ExecuteRequest {
    ExecuteRequest {
        session_id: id.clone(),
        tool_call_id: "parent".into(),
        source: source.into(),
        enabled_tools: vec![EnabledTool {
            global_name: "echo".into(),
            tool_name: "echo_tool".into(),
            description: "answer".into(),
            kind: CodeModeToolKind::Function,
            input_schema: serde_json::json!({"type": "object"}),
        }],
        yield_time_ms: 1000,
        max_output_tokens: None,
    }
}

fn wait(session: &CodeModeSession, id: &CellId, millis: u64) -> RuntimeResponse {
    match session
        .wait(WaitRequest {
            cell_id: id.clone(),
            yield_time_ms: millis,
            max_output_tokens: None,
            terminate: false,
        })
        .unwrap()
    {
        WaitOutcome::LiveCell { response } => response,
        result => panic!("unexpected {result:?}"),
    }
}

fn finish(session: &CodeModeSession, id: &CellId) -> Vec<OutputItem> {
    for _ in 0..10 {
        if let RuntimeResponse::Result {
            content_items,
            error_text,
            ..
        } = wait(session, id, 1000)
        {
            assert_eq!(error_text, None);
            return content_items;
        }
    }
    panic!("cell did not finish");
}

fn text(value: &str) -> Vec<OutputItem> {
    vec![OutputItem::Text { text: value.into() }]
}

#[test]
fn shared_session_uses_each_execution_authority_and_preserves_values() {
    let host = host();
    let id = CodeModeSessionId::new("thread").unwrap();
    let session = host.session(id.clone(), CodeModeLimits::default());
    let first = Invoker::new(41);
    let second = Invoker::new(42);
    let cell = session
        .execute(
            request(
                &id,
                "store('answer', await tools.echo({input:true})); text(load('answer'));",
            ),
            first.clone(),
        )
        .unwrap();
    assert_eq!(finish(&session, &cell.cell_id), text("41"));
    let cell = session.execute(request(&id, "text(load('answer') + await tools.echo({input:false})); store('answer', undefined);"), second.clone()).unwrap();
    assert_eq!(finish(&session, &cell.cell_id), text("83"));
    let cell = session
        .execute(
            request(&id, "text(load('answer') === undefined);"),
            second.clone(),
        )
        .unwrap();
    assert_eq!(finish(&session, &cell.cell_id), text("true"));
    assert_eq!(first.calls.lock().unwrap().len(), 1);
    assert_eq!(second.calls.lock().unwrap().len(), 1);
    assert_eq!(
        first.calls.lock().unwrap()[0].input,
        serde_json::json!({"input":true})
    );
}

#[test]
fn concurrent_sessions_keep_results_and_cancellation_separate() {
    let host = host();
    let slow_id = CodeModeSessionId::new("slow").unwrap();
    let slow = host.session(slow_id.clone(), CodeModeLimits::default());
    let slow_invoker = Invoker::new(0);
    let slow_cell = slow
        .execute(request(&slow_id, "while (true) {}"), slow_invoker.clone())
        .unwrap();
    assert!(matches!(
        wait(&slow, &slow_cell.cell_id, 0),
        RuntimeResponse::Running { .. }
    ));
    std::thread::scope(|scope| {
        let waiter = scope.spawn(|| wait(&slow, &slow_cell.cell_id, 400));
        let jobs = (0..4)
            .map(|index| {
                let host = host.clone();
                scope.spawn(move || {
                    let id = CodeModeSessionId::new(format!("thread-{index}")).unwrap();
                    let session = host.session(id.clone(), CodeModeLimits::default());
                    let invoker = Invoker::new(index);
                    let cell = session
                        .execute(request(&id, "text(await tools.echo({}));"), invoker.clone())
                        .unwrap();
                    assert_eq!(finish(&session, &cell.cell_id), text(&index.to_string()));
                    session.close();
                    assert_eq!(invoker.calls.lock().unwrap().len(), 1);
                })
            })
            .collect::<Vec<_>>();
        for job in jobs {
            job.join().unwrap();
        }
        assert!(matches!(
            waiter.join().unwrap(),
            RuntimeResponse::Running { .. }
        ));
    });
    assert!(slow_invoker.cancelled.lock().unwrap().is_empty());
    slow.terminate(&slow_cell.cell_id).unwrap();
    assert!(
        slow_invoker
            .cancelled
            .lock()
            .unwrap()
            .contains(&slow_cell.cell_id)
    );
    let next = CodeModeSessionId::new("after-close").unwrap();
    let session = host.session(next.clone(), CodeModeLimits::default());
    let cell = session
        .execute(request(&next, "text(42);"), Invoker::new(0))
        .unwrap();
    assert_eq!(finish(&session, &cell.cell_id), text("42"));
}

#[test]
fn invalid_requests_and_admission_limits_do_not_poison_other_sessions() {
    let host = host();
    let id = CodeModeSessionId::new("bounded").unwrap();
    let session = host.session(id.clone(), CodeModeLimits::default());
    assert!(session.execute(request(&id, ""), Invoker::new(0)).is_err());
    let mut cells = vec![];
    for _ in 0..8 {
        cells.push(
            session
                .execute(request(&id, "text(1)"), Invoker::new(0))
                .unwrap()
                .cell_id,
        );
    }
    assert!(
        session
            .execute(request(&id, "text(2)"), Invoker::new(0))
            .is_err()
    );
    session.close();
    let id = CodeModeSessionId::new("healthy").unwrap();
    let session = host.session(id.clone(), CodeModeLimits::default());
    let cell = session
        .execute(request(&id, "text(42)"), Invoker::new(0))
        .unwrap();
    assert_eq!(finish(&session, &cell.cell_id), text("42"));
}

#[test]
fn default_client_reports_missing_host() {
    if std::env::var_os("ASH_MISSING_HOST_TEST").is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "default_client_reports_missing_host"])
            .env("ASH_MISSING_HOST_TEST", "1")
            .env(
                "ASH_CODE_MODE_HOST_BIN",
                std::path::Path::new(env!("CARGO_BIN_EXE_ash-code-mode-host")).join("missing"),
            )
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        return;
    }
    let id = CodeModeSessionId::new("missing").unwrap();
    let session = CodeModeHost::default().session(id.clone(), CodeModeLimits::default());
    let error = session
        .execute(request(&id, "text(1)"), Invoker::new(0))
        .unwrap_err();
    assert!(error.to_string().contains("failed to start Code Mode Host"));
}

#[test]
fn terminate_interrupts_an_inflight_observation_without_breaking_the_host() {
    let host = host();
    let id = CodeModeSessionId::new("interrupt").unwrap();
    let session = host.session(id.clone(), CodeModeLimits::default());
    let invoker = Invoker::new(0);
    let cell = session
        .execute(request(&id, "while (true) {}"), invoker.clone())
        .unwrap();
    assert!(matches!(
        wait(&session, &cell.cell_id, 0),
        RuntimeResponse::Running { .. }
    ));
    std::thread::scope(|scope| {
        let waiter = scope.spawn(|| {
            loop {
                match session.wait(WaitRequest {
                    cell_id: cell.cell_id.clone(),
                    yield_time_ms: 30_000,
                    max_output_tokens: None,
                    terminate: false,
                }) {
                    Ok(result) => break result,
                    Err(error) if error.to_string().contains("active observation") => {
                        std::thread::yield_now()
                    }
                    Err(error) => panic!("{error}"),
                }
            }
        });
        // Establish that the long observation owns the cell before cancelling it.
        let mut observing = false;
        for _ in 0..1000 {
            if session
                .wait(WaitRequest {
                    cell_id: cell.cell_id.clone(),
                    yield_time_ms: 0,
                    max_output_tokens: None,
                    terminate: false,
                })
                .is_err()
            {
                observing = true;
                break;
            }
            std::thread::yield_now();
        }
        assert!(observing, "long poll did not start");
        let result = session.terminate(&cell.cell_id).unwrap();
        let other = waiter.join().unwrap();
        for result in [result, other] {
            assert!(matches!(
                result,
                WaitOutcome::MissingCell { .. }
                    | WaitOutcome::LiveCell {
                        response: RuntimeResponse::Terminated { .. }
                    }
            ));
        }
    });
    let cell = session.execute(request(&id, "text(42)"), invoker).unwrap();
    assert_eq!(finish(&session, &cell.cell_id), text("42"));
}
