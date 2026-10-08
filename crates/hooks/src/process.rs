use crate::error::hook_execution_error;
use crate::outcome::HookDecision;
use crate::outcome::parse_output;
use ash_async_utils::CancellationToken;
use ash_config::HookAction;
use ash_config::HookConfig;
use ash_file_access::Dir;
use ash_sandboxing::SandboxBackends;
use ash_tool_executor::ApprovalPolicy;
use ash_tool_executor::ApprovalRequirement;
use ash_tool_executor::CommandExecutionAuthority;
use ash_tool_executor::CommandExecutionOutcome;
use ash_tool_executor::CommandExecutor;
use ash_tool_executor::CommandInput;
use ash_tool_executor::CommandRequest;
use ash_tool_executor::ExecutionLimits;
use core_api::CoreError;
use std::time::Duration;

const HOOK_TIMEOUT: Duration = Duration::from_secs(30);
const HOOK_OUTPUT_BYTES: usize = 64 * 1024;

pub(crate) trait HookProcessExecutor: Send + Sync {
    fn dir(&self) -> &Dir;

    fn execute(
        &self,
        hook: &HookConfig,
        input: Vec<u8>,
        authority: CommandExecutionAuthority,
        cancellation: &CancellationToken,
    ) -> Result<HookDecision, CoreError>;
}

struct AlwaysAuthorized;

impl ApprovalPolicy for AlwaysAuthorized {
    fn requirement_for(&self, _: &str) -> ApprovalRequirement {
        ApprovalRequirement::NotRequired
    }
}

pub(crate) struct LocalHookProcessExecutor {
    dir: Dir,
    executor: CommandExecutor<AlwaysAuthorized, SandboxBackends>,
}

impl LocalHookProcessExecutor {
    pub(crate) fn new(dir: Dir) -> Self {
        Self {
            dir: dir.clone(),
            executor: CommandExecutor::new(
                dir,
                exec_server::LocalSandbox::new(ash_install_context::InstallContext::current())
                    .build(),
                AlwaysAuthorized,
                ExecutionLimits {
                    timeout: HOOK_TIMEOUT,
                    max_output_bytes: HOOK_OUTPUT_BYTES,
                },
            ),
        }
    }

    pub(crate) fn execute_process(
        dir: Dir,
        hook: &HookConfig,
        authority: CommandExecutionAuthority,
        timeout: Duration,
        cancellation: &CancellationToken,
    ) -> Result<ash_tool_executor::CommandOutput, CoreError> {
        let HookAction::Process { program, args } = &hook.action;
        let executor = CommandExecutor::new(
            dir.clone(),
            exec_server::LocalSandbox::new(ash_install_context::InstallContext::current()).build(),
            AlwaysAuthorized,
            ExecutionLimits {
                timeout,
                max_output_bytes: HOOK_OUTPUT_BYTES,
            },
        );
        process_output(executor.execute(
            CommandRequest {
                program: program.clone(),
                arguments: args.clone(),
                working_directory: ".".into(),
                input: CommandInput::Closed,
            },
            authority,
            cancellation,
        ))
    }
}

pub(crate) fn process_output(
    outcome: Result<CommandExecutionOutcome, ash_tool_executor::ExecutionError>,
) -> Result<ash_tool_executor::CommandOutput, CoreError> {
    match outcome {
        Ok(CommandExecutionOutcome::Completed(output)) => Ok(output),
        Ok(CommandExecutionOutcome::SandboxDenied(_)) => Err(CoreError::Policy(
            "Workflow Hook was denied by the directory sandbox".into(),
        )),
        Err(error) => Err(CoreError::Execution(hook_execution_error(error))),
    }
}

impl HookProcessExecutor for LocalHookProcessExecutor {
    fn dir(&self) -> &Dir {
        &self.dir
    }

    fn execute(
        &self,
        hook: &HookConfig,
        input: Vec<u8>,
        authority: CommandExecutionAuthority,
        cancellation: &CancellationToken,
    ) -> Result<HookDecision, CoreError> {
        let HookAction::Process { program, args } = &hook.action;
        let result = self.executor.execute(
            CommandRequest {
                program: program.clone(),
                arguments: args.clone(),
                working_directory: ".".into(),
                input: CommandInput::Bytes(input),
            },
            authority,
            cancellation,
        );
        match result {
            Ok(CommandExecutionOutcome::Completed(output)) => {
                parse_output(hook.id.as_str(), output)
            }
            Ok(CommandExecutionOutcome::SandboxDenied(_)) => Err(CoreError::Policy(format!(
                "Hook '{}' was denied by the directory sandbox",
                hook.id
            ))),
            Err(error) => Err(CoreError::Execution(hook_execution_error(error))),
        }
    }
}

#[cfg(all(test, unix))]
#[path = "process_tests.rs"]
mod tests;
