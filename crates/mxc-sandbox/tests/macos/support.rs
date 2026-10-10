use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use ash_install_context::InstallContext;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::SandboxPolicy;
use ash_sandboxing::SandboxScope;
use ash_tool_executor::ApprovalPolicy;
use ash_tool_executor::ApprovalRequirement;
use ash_tool_executor::CommandExecutionAuthority;
use ash_tool_executor::CommandExecutionOutcome;
use ash_tool_executor::CommandExecutor;
use ash_tool_executor::CommandInput;
use ash_tool_executor::CommandOutput;
use ash_tool_executor::CommandRequest;
use ash_tool_executor::ExecutionLimits;
use mxc_sandbox::MxcSandbox;
use std::path::Path;
use std::time::Duration;
use std::time::Instant;

struct Approved;

impl ApprovalPolicy for Approved {
    fn requirement_for(&self, _: &str) -> ApprovalRequirement {
        ApprovalRequirement::NotRequired
    }
}

pub(super) fn scope(path: &Path) -> SandboxScope {
    SandboxScope::single(Dir::open_local(path).unwrap())
}

pub(super) fn run(
    scope: &SandboxScope,
    access: FileSystemAccess,
    program: &Path,
    arguments: Vec<String>,
    input: CommandInput,
) -> Result<CommandOutput, String> {
    run_authorized(
        scope,
        CommandExecutionAuthority::Sandboxed(SandboxPolicy::new(access, NetworkAccess::Denied)),
        program,
        arguments,
        input,
    )
}

pub(super) fn run_control(
    scope: &SandboxScope,
    program: &Path,
    arguments: Vec<String>,
    input: CommandInput,
) -> Result<CommandOutput, String> {
    run_authorized(
        scope,
        CommandExecutionAuthority::Unrestricted,
        program,
        arguments,
        input,
    )
}

fn run_authorized(
    scope: &SandboxScope,
    authority: CommandExecutionAuthority,
    program: &Path,
    arguments: Vec<String>,
    input: CommandInput,
) -> Result<CommandOutput, String> {
    let executor = CommandExecutor::new(
        scope.command_dir().clone(),
        MxcSandbox::new(InstallContext::current()),
        Approved,
        ExecutionLimits {
            timeout: Duration::from_secs(5),
            max_output_bytes: 16384,
        },
    );
    let started = Instant::now();
    let result = executor.execute_scoped(
        CommandRequest {
            program: program.to_str().unwrap().into(),
            arguments,
            working_directory: ".".into(),
            input,
        },
        authority,
        &CancellationSource::new().token(),
        Some(scope),
    );
    eprintln!(
        "sandbox probe {program:?} ({authority:?}): {:?}",
        started.elapsed()
    );
    match result {
        Ok(CommandExecutionOutcome::Completed(output)) => Ok(output),
        Ok(CommandExecutionOutcome::SandboxDenied(denial)) => Err(format!("{denial:?}")),
        Err(error) => Err(format!("{program:?} ({authority:?}): {error:?}")),
    }
}
