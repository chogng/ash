use super::*;
use serde_json::json;
use std::fs;
use std::future::Future;
#[cfg(target_os = "macos")]
use std::net::TcpListener;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll, Waker};
use std::time::Duration;
use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use ash_protocol::{ToolCallId, TurnId};
use ash_sandboxing::{
    PreparedCommand, SandboxBackend, SandboxCommand, SandboxError, SandboxKind, SandboxPolicy,
};
use ash_tools::{
    EnvId, ProcessExitStatus, ToolBinding, ToolBindingId, ToolDefinition, ToolExecutionContext,
    ToolExecutionOutcome, ToolExecutor, ToolInvocation, ToolOperationId, ToolOutputStatus,
    ToolPayload, ToolRegistryGeneration, ToolReplaySafety, ToolRuntimeAuthority, ToolRuntimeKey,
};

struct DenyAll;

impl ApprovalPolicy for DenyAll {
    fn requirement_for(&self, _: &str) -> ash_tool_executor::ApprovalRequirement {
        ash_tool_executor::ApprovalRequirement::Denied
    }
}

struct AllowAll;

impl ApprovalPolicy for AllowAll {
    fn requirement_for(&self, _: &str) -> ash_tool_executor::ApprovalRequirement {
        ash_tool_executor::ApprovalRequirement::NotRequired
    }
}

struct MustNotPrepare;

impl SandboxBackend for MustNotPrepare {
    fn kind(&self) -> SandboxKind {
        SandboxKind::Unrestricted
    }

    fn prepare(
        &self,
        _: &SandboxCommand,
        _: SandboxPolicy,
        _: &Dir,
    ) -> Result<PreparedCommand, SandboxError> {
        panic!("denied commands must not reach sandbox preparation")
    }
}

struct RecordingBackend {
    policies: Arc<Mutex<Vec<SandboxPolicy>>>,
}

struct UnavailableBackend;

impl SandboxBackend for UnavailableBackend {
    fn kind(&self) -> SandboxKind {
        SandboxKind::Restricted
    }

    fn prepare(
        &self,
        _: &SandboxCommand,
        _: SandboxPolicy,
        _: &Dir,
    ) -> Result<PreparedCommand, SandboxError> {
        Err(SandboxError::BackendUnavailable {
            backend: SandboxKind::Restricted,
            message: "test backend unavailable".into(),
        })
    }
}

impl SandboxBackend for RecordingBackend {
    fn prepare_scoped(
        &self,
        command: &SandboxCommand,
        policy: SandboxPolicy,
        scope: &ash_sandboxing::SandboxScope,
    ) -> Result<PreparedCommand, SandboxError> {
        // This fixture records policy delivery; OS isolation has separate real-backend tests.
        self.prepare(command, policy, scope.command_dir())
    }

    fn kind(&self) -> SandboxKind {
        SandboxKind::Unrestricted
    }

    fn prepare(
        &self,
        command: &SandboxCommand,
        policy: SandboxPolicy,
        _: &Dir,
    ) -> Result<PreparedCommand, SandboxError> {
        self.policies.lock().unwrap().push(policy);
        #[cfg(windows)]
        let prepared = PreparedCommand::new(
            SandboxKind::Unrestricted,
            "cmd.exe",
            ["/C", "echo", "sandbox-authority-reached-executor"],
            command.working_directory(),
        );
        #[cfg(not(windows))]
        let prepared = PreparedCommand::new(
            SandboxKind::Unrestricted,
            "/bin/sh",
            ["-c", "printf sandbox-authority-reached-executor"],
            command.working_directory(),
        );
        Ok(prepared)
    }
}

#[test]
fn denied_command_is_returned_as_a_model_visible_error() {
    let dir = TestDir::new();
    let tool = ShellCommandTool::new(
        environment_id(),
        dir.root(),
        MustNotPrepare,
        DenyAll,
        ShellCommandLimits {
            timeout: Duration::from_secs(1),
            max_output_bytes: 1024,
        },
    )
    .unwrap();
    let definition = tool.definition();

    let outcome = resolve(tool.execute(invocation(
        &definition,
        json!({"program": "not-started", "arguments": [], "working_directory": "."}),
    )));

    let ToolExecutionOutcome::Returned(output) = outcome else {
        panic!("denied command should return a tool error");
    };
    assert_eq!(output.status(), ToolOutputStatus::Error);
    assert!(format!("{:?}", output.content()).contains("denied by policy"));
}

#[test]
fn empty_program_is_rejected_before_execution() {
    let dir = TestDir::new();
    let tool = ShellCommandTool::new(
        environment_id(),
        dir.root(),
        MustNotPrepare,
        DenyAll,
        ShellCommandLimits {
            timeout: Duration::from_secs(1),
            max_output_bytes: 1024,
        },
    )
    .unwrap();
    let definition = tool.definition();

    let outcome = resolve(tool.execute(invocation(
        &definition,
        json!({"program": "", "arguments": [], "working_directory": "."}),
    )));

    let ToolExecutionOutcome::Returned(output) = outcome else {
        panic!("empty program should return a tool error");
    };
    assert_eq!(output.status(), ToolOutputStatus::Error);
    assert!(format!("{:?}", output.content()).contains("must not be empty"));
}

#[test]
fn each_invocation_authority_reaches_the_process_backend() {
    let dir = TestDir::new();
    let policies = Arc::new(Mutex::new(Vec::new()));
    let sandbox = SandboxPolicy::new(
        ash_sandboxing::FileSystemAccess::DirectoryWrite,
        ash_sandboxing::NetworkAccess::Denied,
    );
    let tool = ShellCommandTool::new(
        environment_id(),
        dir.root(),
        RecordingBackend {
            policies: policies.clone(),
        },
        AllowAll,
        ShellCommandLimits {
            timeout: Duration::from_secs(1),
            max_output_bytes: 1024,
        },
    )
    .unwrap();
    let definition = tool.definition();

    let outcome = resolve(tool.execute(invocation_with_authority(
        &definition,
        json!({"program": "must-be-replaced", "arguments": [], "working_directory": "."}),
        ToolRuntimeAuthority::Sandboxed(sandbox),
    )));

    let ToolExecutionOutcome::Returned(output) = outcome else {
        panic!("sandboxed command should return its backend-prepared output: {outcome:?}");
    };
    assert_eq!(output.status(), ToolOutputStatus::Success);
    assert!(format!("{:?}", output.content()).contains("sandbox-authority-reached-executor"));

    let outcome = resolve(tool.execute(invocation(
        &definition,
        json!({"program": "must-be-replaced", "arguments": [], "working_directory": "."}),
    )));
    let ToolExecutionOutcome::Returned(output) = outcome else {
        panic!("unrestricted command should return its backend-prepared output");
    };
    assert_eq!(output.status(), ToolOutputStatus::Success);
    assert_eq!(
        *policies.lock().unwrap(),
        vec![
            sandbox,
            SandboxPolicy::new(
                ash_sandboxing::FileSystemAccess::FullAccess,
                ash_sandboxing::NetworkAccess::Allowed,
            ),
        ]
    );
}

#[test]
fn unavailable_sandbox_is_a_safe_to_retry_structured_denial() {
    let dir = TestDir::new();
    let tool = ShellCommandTool::new(
        environment_id(),
        dir.root(),
        UnavailableBackend,
        AllowAll,
        ShellCommandLimits {
            timeout: Duration::from_secs(1),
            max_output_bytes: 1024,
        },
    )
    .unwrap();
    let definition = tool.definition();

    let outcome = resolve(tool.execute(invocation_with_authority(
        &definition,
        json!({"program": "/usr/bin/true", "arguments": [], "working_directory": "."}),
        ToolRuntimeAuthority::Sandboxed(SandboxPolicy::new(
            ash_sandboxing::FileSystemAccess::ReadOnly,
            ash_sandboxing::NetworkAccess::Denied,
        )),
    )));

    let ToolExecutionOutcome::SandboxDenied(denial) = outcome else {
        panic!("unavailable sandbox should be a structured denial");
    };
    assert_eq!(denial.replay_safety(), ToolReplaySafety::SafeToRetry);
    assert_eq!(denial.output().exit_status(), ProcessExitStatus::Terminated);
    assert!(denial.output().stdout().is_empty());
    assert!(denial.output().stderr().is_empty());
}

#[cfg(target_os = "macos")]
#[test]
fn sandboxed_tool_invocation_enforces_dir_metadata_and_network_boundaries() {
    use mxc_sandbox::MxcSandbox;

    let dir = TestDir::new();
    let protected = dir.path.join(".git");
    fs::create_dir_all(&protected).unwrap();
    let outside = dir.path.with_extension("outside");
    let _outside_cleanup = RemovePathOnDrop(outside.clone());
    let sandbox = SandboxPolicy::new(
        ash_sandboxing::FileSystemAccess::DirectoryWrite,
        ash_sandboxing::NetworkAccess::Denied,
    );
    let tool = ShellCommandTool::new(
        environment_id(),
        dir.root(),
        MxcSandbox::new(ash_install_context::InstallContext::current()),
        AllowAll,
        ShellCommandLimits {
            timeout: Duration::from_secs(3),
            max_output_bytes: 16 * 1024,
        },
    )
    .unwrap();
    let definition = tool.definition();

    let allowed_outcome = execute_sandboxed_command(
        &tool,
        &definition,
        sandbox,
        "/usr/bin/touch",
        vec!["ordinary.txt".into()],
    );
    if let ToolExecutionOutcome::SandboxDenied(denial) = &allowed_outcome {
        assert_eq!(denial.replay_safety(), ToolReplaySafety::SafeToRetry);
        assert!(denial.reason().contains("could not apply"));
        return;
    }
    let allowed = completed_output(allowed_outcome);
    assert_eq!(allowed["result"]["exit_code"], json!(0));
    assert!(dir.path.join("ordinary.txt").exists());

    let outside_write = execute_sandboxed_command(
        &tool,
        &definition,
        sandbox,
        "/usr/bin/touch",
        vec![outside.to_string_lossy().into_owned()],
    );
    assert_sandbox_denial(outside_write);
    assert!(!outside.exists());

    let metadata_write = execute_sandboxed_command(
        &tool,
        &definition,
        sandbox,
        "/usr/bin/touch",
        vec![".git/persisted-hook".into()],
    );
    assert_sandbox_denial(metadata_write);
    assert!(!protected.join("persisted-hook").exists());

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let network = execute_sandboxed_command(
        &tool,
        &definition,
        sandbox,
        "/usr/bin/nc",
        vec![
            "-z".into(),
            "-w".into(),
            "1".into(),
            "127.0.0.1".into(),
            port.to_string(),
        ],
    );
    let network = completed_output(network);
    assert_ne!(network["result"]["exit_code"], json!(0));
    let error = listener
        .accept()
        .expect_err("sandboxed command must not reach the loopback listener");
    assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
}

#[cfg(target_os = "macos")]
fn execute_sandboxed_command(
    tool: &ShellCommandTool<AllowAll, mxc_sandbox::MxcSandbox>,
    definition: &ToolDefinition,
    sandbox: SandboxPolicy,
    program: &str,
    arguments: Vec<String>,
) -> ToolExecutionOutcome {
    resolve(tool.execute(invocation_with_authority(
        definition,
        json!({
            "program": program,
            "arguments": arguments,
            "working_directory": ".",
        }),
        ToolRuntimeAuthority::Sandboxed(sandbox),
    )))
}

#[cfg(target_os = "macos")]
fn completed_output(outcome: ToolExecutionOutcome) -> serde_json::Value {
    let ToolExecutionOutcome::Returned(output) = &outcome else {
        panic!("allowed sandboxed command should return its terminal result: {outcome:?}");
    };
    assert_eq!(output.status(), ToolOutputStatus::Success);
    let [ash_tools::ToolContent::Text(text)] = output.content() else {
        panic!("shell command should return one JSON text item");
    };
    serde_json::from_str(text).unwrap()
}

#[cfg(target_os = "macos")]
fn assert_sandbox_denial(outcome: ToolExecutionOutcome) {
    let ToolExecutionOutcome::SandboxDenied(denial) = outcome else {
        panic!("sandbox enforcement should return a structured denial");
    };
    assert_eq!(denial.replay_safety(), ToolReplaySafety::MayHaveSideEffects);
    assert!(matches!(
        denial.output().exit_status(),
        ProcessExitStatus::Code(code) if code != 0
    ));
    assert!(!denial.output().stderr().is_empty());
}

static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn new() -> Self {
        let sequence = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ash-shell-command-tests-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn root(&self) -> Dir {
        Dir::open_local(&self.path).unwrap()
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[cfg(target_os = "macos")]
struct RemovePathOnDrop(PathBuf);

#[cfg(target_os = "macos")]
impl Drop for RemovePathOnDrop {
    fn drop(&mut self) {
        if self.0.is_dir() {
            let _ = fs::remove_dir_all(&self.0);
        } else {
            let _ = fs::remove_file(&self.0);
        }
    }
}

fn environment_id() -> EnvId {
    EnvId::new("test-environment").unwrap()
}

fn invocation(definition: &ToolDefinition, arguments: serde_json::Value) -> ToolInvocation {
    invocation_with_authority(definition, arguments, ToolRuntimeAuthority::Unrestricted)
}

fn invocation_with_authority(
    definition: &ToolDefinition,
    arguments: serde_json::Value,
    authority: ToolRuntimeAuthority,
) -> ToolInvocation {
    ToolInvocation::new(
        ToolOperationId::new("operation-1").unwrap(),
        ToolCallId::new("call-1").unwrap(),
        TurnId::new("turn-1").unwrap(),
        ToolBinding::new(
            ToolRegistryGeneration::new(1),
            ToolBindingId::new("binding-1").unwrap(),
            definition.name().clone(),
            definition.digest(),
            ToolRuntimeKey::new("local:test").unwrap(),
        ),
        ToolPayload::FunctionArguments(arguments),
        ToolExecutionContext::new(
            environment_id(),
            CancellationSource::new().token(),
            authority,
        ),
    )
}

fn resolve(
    mut future: Pin<Box<dyn Future<Output = ToolExecutionOutcome> + Send + '_>>,
) -> ToolExecutionOutcome {
    let waker: &Waker = Waker::noop();
    let mut context = Context::from_waker(waker);
    match future.as_mut().poll(&mut context) {
        Poll::Ready(outcome) => outcome,
        Poll::Pending => panic!("local tool future should complete synchronously"),
    }
}
