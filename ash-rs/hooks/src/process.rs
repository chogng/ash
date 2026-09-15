use crate::error::hook_execution_error;
use crate::outcome::HookDecision;
use crate::outcome::parse_output;
use std::time::Duration;
use ash_async_utils::CancellationToken;
use ash_config::HookAction;
use ash_config::HookConfig;
use core_api::CoreError;
use ash_file_access::Dir;
use ash_tool_executor::ApprovalPolicy;
use ash_tool_executor::ApprovalRequirement;
use ash_tool_executor::CommandExecutionAuthority;
use ash_tool_executor::CommandExecutionOutcome;
use ash_tool_executor::CommandExecutor;
use ash_tool_executor::CommandInput;
use ash_tool_executor::CommandRequest;
use ash_tool_executor::ExecutionLimits;

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
    executor: CommandExecutor<AlwaysAuthorized, mxc_sandbox::MxcSandbox>,
}

impl LocalHookProcessExecutor {
    pub(crate) fn new(dir: Dir) -> Self {
        let backend = mxc_sandbox::MxcSandbox::new(ash_install_context::InstallContext::current());
        Self {
            dir: dir.clone(),
            executor: CommandExecutor::new(
                dir,
                backend,
                AlwaysAuthorized,
                ExecutionLimits {
                    timeout: HOOK_TIMEOUT,
                    max_output_bytes: HOOK_OUTPUT_BYTES,
                },
            ),
        }
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
                working_directory: self.dir.canonical_path().to_path_buf(),
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
