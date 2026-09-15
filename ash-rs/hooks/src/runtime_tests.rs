use super::*;
use crate::HookRunEvent;
use crate::HookRunStatus;
use crate::process::HookProcessExecutor;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ExecutionDecision;
use ash_async_utils::CancellationSource;
use ash_config::HookAction;
use ash_config::HookConfig;
use ash_config::HookEnablement;
use ash_config::HookEvent as ConfigHookEvent;
use core_api::AfterToolHookRequest;
use core_api::BeforeToolHookRequest;
use core_api::HookOutcome;
use core_api::HookExecutionEvent;
use core_api::HookExecutionObserver;
use ash_protocol::ThreadId;
use ash_protocol::ToolCallId;
use ash_protocol::TurnId;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::SandboxPolicy;
use ash_tool_executor::CommandExecutionAuthority;

struct TestPolicy;

impl core_api::ActionPolicyService for TestPolicy {
    fn revision(&self) -> String {
        "hook-test-policy".into()
    }

    fn decide(
        &self,
        _: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        Ok(ExecutionDecision::RunSandboxed(SandboxPolicy::new(
            FileSystemAccess::DirectoryWrite,
            NetworkAccess::Denied,
        )))
    }
}

struct RecordingProcess {
    dir: Dir,
    executions: Mutex<Vec<String>>,
    calls: AtomicUsize,
    decision: Mutex<crate::outcome::HookDecision>,
}

#[derive(Default)]
struct RecordingObserver {
    started: Mutex<Vec<HookExecutionEvent>>,
    finished: Mutex<Vec<HookExecutionEvent>>,
}

impl HookExecutionObserver for RecordingObserver {
    fn will_execute(&self, event: &HookExecutionEvent) -> Result<(), CoreError> {
        self.started
            .lock()
            .expect("observer start lock")
            .push(event.clone());
        Ok(())
    }

    fn did_finish(&self, event: &HookExecutionEvent) {
        self.finished
            .lock()
            .expect("observer finish lock")
            .push(event.clone());
    }
}

impl HookProcessExecutor for RecordingProcess {
    fn dir(&self) -> &Dir {
        &self.dir
    }

    fn execute(
        &self,
        hook: &HookConfig,
        _: Vec<u8>,
        _: CommandExecutionAuthority,
        _: &CancellationToken,
    ) -> Result<crate::outcome::HookDecision, CoreError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.executions
            .lock()
            .expect("recording process lock")
            .push(hook.id.to_string());
        Ok(self
            .decision
            .lock()
            .expect("recording decision lock")
            .clone())
    }
}

fn hook(
    id: &str,
    event: ConfigHookEvent,
    tool_names: &[&str],
    enablement: HookEnablement,
) -> HookConfig {
    HookConfig {
        id: ash_config::HookId::new(id).expect("test Hook id"),
        event,
        matcher: ash_config::HookMatcher {
            tool_names: tool_names.iter().map(|name| (*name).into()).collect(),
        },
        action: HookAction::Process {
            program: "hook-program".into(),
            args: Vec::new(),
        },
        enablement,
    }
}

fn runtime(
    hooks: impl IntoIterator<Item = HookConfig>,
) -> (DeclarativeHookRuntime, Arc<RecordingProcess>) {
    let dir = test_dir();
    let process = Arc::new(RecordingProcess {
        dir,
        executions: Mutex::new(Vec::new()),
        calls: AtomicUsize::new(0),
        decision: Mutex::new(crate::outcome::HookDecision::Continue),
    });
    let config = HooksConfig {
        hooks: hooks
            .into_iter()
            .map(|hook| (hook.id.clone(), hook))
            .collect(),
    };
    (
        DeclarativeHookRuntime::with_process(config, Arc::new(TestPolicy), process.clone()),
        process,
    )
}

fn test_dir() -> Dir {
    Dir::open_local(std::env::current_dir().expect("test working directory")).expect("dir root")
}

fn before_request(tool_name: &str) -> BeforeToolHookRequest {
    BeforeToolHookRequest {
        session_id: ash_protocol::SessionId::new("session").unwrap(),
        thread_id: ThreadId::new("thread-test").unwrap(),
        turn_id: TurnId::new("turn-test").unwrap(),
        tool_call_id: ToolCallId::new("tool-test").unwrap(),
        tool_name: tool_name.into(),
    }
}

fn after_request(tool_name: &str, outcome: HookOutcome) -> AfterToolHookRequest {
    AfterToolHookRequest {
        session_id: ash_protocol::SessionId::new("session").unwrap(),
        thread_id: ThreadId::new("thread-test").unwrap(),
        turn_id: TurnId::new("turn-test").unwrap(),
        tool_call_id: ToolCallId::new("tool-test").unwrap(),
        tool_name: tool_name.into(),
        outcome,
    }
}

#[test]
fn runtime_matches_events_and_tool_filters_in_stable_order() {
    let (runtime, process) = runtime([
        hook(
            "user:hook:after",
            ConfigHookEvent::AfterTool,
            &["shell-command"],
            HookEnablement::Enabled,
        ),
        hook(
            "user:hook:before-shell",
            ConfigHookEvent::BeforeTool,
            &["shell-command"],
            HookEnablement::Enabled,
        ),
        hook(
            "user:hook:before-all",
            ConfigHookEvent::BeforeTool,
            &[],
            HookEnablement::Enabled,
        ),
        hook(
            "user:hook:disabled",
            ConfigHookEvent::BeforeTool,
            &[],
            HookEnablement::Disabled,
        ),
    ]);
    let source = CancellationSource::new();

    runtime
        .before_tool(&before_request("shell-command"), &source.token())
        .expect("before Hook run");
    runtime
        .after_tool(
            &after_request("file-system", HookOutcome::Succeeded),
            &source.token(),
        )
        .expect("non-matching after Hook run");

    assert_eq!(
        process
            .executions
            .lock()
            .expect("recording process lock")
            .as_slice(),
        ["user:hook:before-all", "user:hook:before-shell"]
    );
}

#[test]
fn managed_thread_hooks_use_the_thread_process_and_report_its_lifecycle() {
    let (runtime, primary) = runtime([hook(
        "user:hook:thread",
        ConfigHookEvent::BeforeTool,
        &[],
        HookEnablement::Enabled,
    )]);
    let thread_process = Arc::new(RecordingProcess {
        dir: test_dir(),
        executions: Mutex::new(Vec::new()),
        calls: AtomicUsize::new(0),
        decision: Mutex::new(crate::outcome::HookDecision::Continue),
    });
    runtime.bind_thread_process(
        ThreadId::new("thread-test").unwrap(),
        thread_process.clone(),
    );
    let observer = Arc::new(RecordingObserver::default());
    runtime.set_execution_observer(observer.clone());

    runtime
        .before_tool(
            &before_request("shell-command"),
            &CancellationSource::new().token(),
        )
        .expect("thread Hook run");

    assert_eq!(primary.calls.load(Ordering::SeqCst), 0);
    assert_eq!(thread_process.calls.load(Ordering::SeqCst), 1);
    assert_eq!(observer.started.lock().unwrap().len(), 1);
    assert_eq!(observer.finished.lock().unwrap().len(), 1);
    assert_eq!(
        observer.started.lock().unwrap()[0].thread_id.as_str(),
        "thread-test"
    );
}

#[test]
fn runtime_checks_cancellation_between_hooks() {
    let (runtime, process) = runtime([
        hook(
            "user:hook:first",
            ConfigHookEvent::BeforeTool,
            &[],
            HookEnablement::Enabled,
        ),
        hook(
            "user:hook:second",
            ConfigHookEvent::BeforeTool,
            &[],
            HookEnablement::Enabled,
        ),
    ]);
    let source = CancellationSource::new();
    source.cancel();

    let error = runtime
        .before_tool(&before_request("shell-command"), &source.token())
        .expect_err("cancelled Hook run");
    assert!(matches!(error, CoreError::Cancelled(_)));
    assert_eq!(process.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn before_tool_denial_is_typed_and_projected_as_a_terminal_run() {
    let (runtime, process) = runtime([hook(
        "user:hook:guard",
        ConfigHookEvent::BeforeTool,
        &[],
        HookEnablement::Enabled,
    )]);
    *process.decision.lock().expect("recording decision lock") =
        crate::outcome::HookDecision::Deny {
            reason: "blocked by repository policy".into(),
        };

    let decision = runtime
        .before_tool(
            &before_request("shell-command"),
            &CancellationSource::new().token(),
        )
        .expect("typed Hook decision");

    assert_eq!(
        decision,
        BeforeToolHookDecision::Deny {
            reason: "blocked by repository policy".into(),
        }
    );
    let runs = runtime.recent_runs();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].run_id, "hook-run-1");
    assert_eq!(runs[0].hook_id, "user:hook:guard");
    assert_eq!(runs[0].event, HookRunEvent::BeforeTool);
    assert_eq!(
        runs[0].status,
        HookRunStatus::Denied {
            reason: "blocked by repository policy".into(),
        }
    );
}
