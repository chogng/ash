use crate::error::hook_execution_error;
use crate::outcome::HookDecision;
use crate::outcome::parse_claude_pre_tool_use;
use crate::outcome::parse_output;
use crate::policy::session_authority;
use ash_async_utils::CancellationToken;
use ash_config::HookAction;
use ash_config::HookConfig;
use ash_file_access::Authorization;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::HostReadAccess;
use ash_file_access::PathAccess;
use ash_file_access::PathOperation;
use ash_file_access::Permission;
use ash_sandboxing::HostReadScope;
use ash_sandboxing::PatternMatchTiming;
use ash_sandboxing::SandboxBackends;
use ash_sandboxing::SandboxDirAccess;
use ash_sandboxing::SandboxDirGrant;
use ash_sandboxing::SandboxPathAccess;
use ash_sandboxing::SandboxPathRule;
use ash_sandboxing::SandboxScope;
use ash_tool_executor::ApprovalPolicy;
use ash_tool_executor::ApprovalRequirement;
use ash_tool_executor::CommandExecutionAuthority;
use ash_tool_executor::CommandExecutionOutcome;
use ash_tool_executor::CommandExecutor;
use ash_tool_executor::CommandInput;
use ash_tool_executor::CommandRequest;
use ash_tool_executor::ExecutionLimits;
use core_api::CoreError;
use std::path::Path;
use std::time::Duration;

const HOOK_TIMEOUT: Duration = Duration::from_secs(30);
const HOOK_OUTPUT_BYTES: usize = 64 * 1024;

pub(crate) trait HookProcessExecutor: Send + Sync {
    fn dir(&self) -> &Dir;

    fn sandbox_scope(&self) -> Option<&SandboxScope> {
        None
    }

    fn execute(
        &self,
        hook: &HookConfig,
        input: Vec<u8>,
        authority: CommandExecutionAuthority,
        cancellation: &CancellationToken,
        evidence: &mut core_api::HookRunEvidence,
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
    session: Option<SessionHookScope>,
}

struct SessionHookScope {
    execution: Authorization,
    sandbox: SandboxScope,
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
            session: None,
        }
    }

    pub(crate) fn for_session_grant(grant: &Grant) -> Result<Self, CoreError> {
        let execution = grant
            .authorize(Permission::ExecuteCommands)
            .map_err(|error| CoreError::Policy(error.to_string()))?;
        let sandbox = session_sandbox_scope(grant)?;
        Ok(Self {
            session: Some(SessionHookScope { execution, sandbox }),
            ..Self::new(grant.dir().clone())
        })
    }

    pub(crate) fn is_authorized(&self) -> bool {
        self.session
            .as_ref()
            .is_none_or(|session| session.execution.is_active())
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
                environment: Default::default(),
            },
            authority,
            cancellation,
        ))
    }
}

fn session_sandbox_scope(grant: &Grant) -> Result<SandboxScope, CoreError> {
    let dir = grant.dir();
    let policy = grant.path_policy();
    let permissions = grant.permissions();
    let root = Path::new("");
    // Sandbox roots support read-only or read-write access. A ceiling that only
    // allows specific files cannot authorize the corresponding operation on the root.
    let access = if !permissions.allows(Permission::ReadFiles)
        || !policy.allows(root, PathOperation::Read)
    {
        SandboxDirAccess::Denied
    } else if permissions.allows(Permission::WriteFiles)
        && policy.allows(root, PathOperation::Write)
    {
        SandboxDirAccess::ReadWrite
    } else {
        SandboxDirAccess::ReadOnly
    };
    let rules = policy
        .rules()
        .filter_map(|rule| {
            let access = match rule.access {
                PathAccess::Denied => SandboxPathAccess::Denied,
                PathAccess::ReadOnly => SandboxPathAccess::ReadOnly,
                PathAccess::ReadWrite => return None,
            };
            Some(SandboxPathRule::pattern(
                dir.clone(),
                rule.pattern.clone(),
                access,
                PatternMatchTiming::Continuous,
            ))
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| CoreError::Policy(error.to_string()))?;
    SandboxScope::new(
        dir.clone(),
        vec![SandboxDirGrant::new(dir.clone(), access)],
        Vec::new(),
    )
    .and_then(|scope| {
        scope
            .with_host_read(match policy.host_read() {
                HostReadAccess::Host => HostReadScope::Host,
                HostReadAccess::GrantedRoots => HostReadScope::Minimal,
            })
            .with_path_rules(rules)
    })
    .map_err(|error| CoreError::Policy(error.to_string()))
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

    fn sandbox_scope(&self) -> Option<&SandboxScope> {
        self.session.as_ref().map(|session| &session.sandbox)
    }

    fn execute(
        &self,
        hook: &HookConfig,
        input: Vec<u8>,
        authority: CommandExecutionAuthority,
        cancellation: &CancellationToken,
        evidence: &mut core_api::HookRunEvidence,
    ) -> Result<HookDecision, CoreError> {
        let HookAction::Process { program, args } = &hook.action;
        let compatibility_executor = hook.claude_pre_tool_use.map(|compatibility| {
            CommandExecutor::new(
                self.dir.clone(),
                exec_server::LocalSandbox::new(ash_install_context::InstallContext::current())
                    .build(),
                AlwaysAuthorized,
                ExecutionLimits {
                    timeout: Duration::from_secs(u64::from(compatibility.timeout_seconds)),
                    max_output_bytes: HOOK_OUTPUT_BYTES,
                },
            )
        });
        let executor = compatibility_executor.as_ref().unwrap_or(&self.executor);
        let scope = self.sandbox_scope();
        let authority = scope.map_or(authority, |scope| session_authority(authority, scope));
        let execute = || {
            executor.execute_scoped(
                CommandRequest {
                    program: program.clone(),
                    arguments: args.clone(),
                    working_directory: ".".into(),
                    input: CommandInput::Bytes(input),
                    environment: Default::default(),
                },
                authority,
                cancellation,
                scope,
            )
        };
        let result = match &self.session {
            Some(session) => session
                .execution
                .execute(
                    session.execution.subject(),
                    &self.dir,
                    Permission::ExecuteCommands,
                    execute,
                )
                .map_err(|error| CoreError::Policy(error.to_string()))?,
            None => execute(),
        };
        match result {
            Ok(CommandExecutionOutcome::Completed(output)) => {
                evidence.stdout = output.stdout.clone();
                evidence.stderr = output.stderr.clone();
                evidence.exit_code = output.exit_code;
                evidence.stdout_truncated = output.stdout_truncated;
                evidence.stderr_truncated = output.stderr_truncated;
                if hook.claude_pre_tool_use.is_some() {
                    parse_claude_pre_tool_use(hook.id.as_str(), output)
                } else {
                    parse_output(hook.id.as_str(), output)
                }
            }
            Ok(CommandExecutionOutcome::SandboxDenied(_)) => Err(CoreError::Policy(format!(
                "Hook '{}' was denied by the directory sandbox",
                hook.id
            ))),
            Err(
                ash_tool_executor::ExecutionError::CancelledBeforeStart(reason)
                | ash_tool_executor::ExecutionError::CancelledAfterStart(reason),
            ) => Err(CoreError::Cancelled(reason)),
            Err(error) => Err(CoreError::Execution(hook_execution_error(error))),
        }
    }
}

#[cfg(test)]
#[path = "process_tests.rs"]
mod tests;
