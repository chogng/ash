//! Tool approval and conversation ownership over the execution service.
use ash_async_utils::CancellationToken;
use ash_file_access::Dir;
use ash_sandboxing::SandboxBackend;
use ash_sandboxing::SandboxError;
use ash_sandboxing::SandboxScope;
use ash_utils_pty::TerminalSize;
pub use exec_server::execution::CommandExecutionAuthority;
pub use exec_server::execution::CommandExecutionOutcome;
pub use exec_server::execution::CommandInput;
pub use exec_server::execution::CommandOutput;
pub use exec_server::execution::CommandRequest;
pub use exec_server::execution::CommandSessionCursor;
pub use exec_server::execution::CommandSessionId;
pub use exec_server::execution::CommandSessionOptions;
pub use exec_server::execution::CommandSessionOutput;
pub use exec_server::execution::CommandSessionStart;
pub use exec_server::execution::CommandSessionStatus;
pub use exec_server::execution::CommandSessionUpdate;
pub use exec_server::execution::CommandTerminalSize;
pub use exec_server::execution::ExecutionLimits;
use exec_server::execution::ProcessExecutor;
use exec_server::execution::ProcessSessionOwner;
use std::time::Duration;

/// Decides whether a fully materialized local process action can start.
///
/// Hosts implement this policy from their approval authority. The executor asks only about the
/// exact program-and-arguments digest and never turns a required approval into permission itself.
pub trait ApprovalPolicy: Send + Sync {
    fn requirement_for(&self, action_digest: &str) -> ApprovalRequirement;
}

/// Distinguishes a command that may start from one awaiting user approval or prohibited by policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalRequirement {
    NotRequired,
    Required,
    Denied,
}

impl ApprovalRequirement {
    pub fn allows_execution(self) -> bool {
        matches!(self, Self::NotRequired)
    }
}

#[derive(Debug)]
pub enum ExecutionError {
    ApprovalRequired,
    Denied,
    Spawn(String),
    CancelledBeforeStart(String),
    CancelledAfterStart(String),
    TimedOut,
    Sandbox(SandboxError),
    Network(String),
}

impl From<exec_server::execution::ExecutionError> for ExecutionError {
    fn from(error: exec_server::execution::ExecutionError) -> Self {
        use exec_server::execution::ExecutionError as E;
        match error {
            E::Spawn(e) => Self::Spawn(e),
            E::CancelledBeforeStart(e) => Self::CancelledBeforeStart(e),
            E::CancelledAfterStart(e) => Self::CancelledAfterStart(e),
            E::TimedOut => Self::TimedOut,
            E::Sandbox(e) => Self::Sandbox(e),
            E::Network(e) => Self::Network(e),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandSessionOwner {
    caller: String,
    thread: String,
    environment: String,
}
impl CommandSessionOwner {
    pub fn new(
        caller: impl Into<String>,
        thread: impl Into<String>,
        environment: impl Into<String>,
    ) -> Self {
        Self {
            caller: caller.into(),
            thread: thread.into(),
            environment: environment.into(),
        }
    }
    fn process_owner(&self) -> ProcessSessionOwner {
        // Length prefixes preserve identity even when a component contains separators.
        ProcessSessionOwner::new(format!(
            "{}:{}{}:{}{}:{}",
            self.caller.len(),
            self.caller,
            self.thread.len(),
            self.thread,
            self.environment.len(),
            self.environment
        ))
    }
}

pub struct CommandExecutor<P, B> {
    approval_policy: P,
    execution: ProcessExecutor<B>,
}
impl<P: ApprovalPolicy, B: SandboxBackend> CommandExecutor<P, B> {
    pub fn new(dir: Dir, backend: B, approval_policy: P, limits: ExecutionLimits) -> Self {
        Self {
            approval_policy,
            execution: ProcessExecutor::new(dir, backend, limits),
        }
    }
    fn approve(
        &self,
        request: &CommandRequest,
        cancellation: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        cancellation
            .check()
            .map_err(|signal| ExecutionError::CancelledBeforeStart(signal.reason().to_string()))?;
        let digest = format!("{}:{}", request.program, request.arguments.join("\u{1f}"));
        match self.approval_policy.requirement_for(&digest) {
            ApprovalRequirement::NotRequired => Ok(()),
            ApprovalRequirement::Required => Err(ExecutionError::ApprovalRequired),
            ApprovalRequirement::Denied => Err(ExecutionError::Denied),
        }
    }
    pub fn execute(
        &self,
        request: CommandRequest,
        authority: CommandExecutionAuthority,
        cancellation: &CancellationToken,
    ) -> Result<CommandExecutionOutcome, ExecutionError> {
        self.execute_in_dir(request, authority, cancellation, None)
    }

    pub fn execute_in_dir(
        &self,
        request: CommandRequest,
        authority: CommandExecutionAuthority,
        cancellation: &CancellationToken,
        dir: Option<&Dir>,
    ) -> Result<CommandExecutionOutcome, ExecutionError> {
        let scope = dir.cloned().map(SandboxScope::single);
        self.execute_scoped(request, authority, cancellation, scope.as_ref())
    }

    pub fn execute_scoped(
        &self,
        request: CommandRequest,
        authority: CommandExecutionAuthority,
        cancellation: &CancellationToken,
        scope: Option<&SandboxScope>,
    ) -> Result<CommandExecutionOutcome, ExecutionError> {
        self.execute_scoped_with_network(request, authority, cancellation, scope, None)
    }

    pub fn execute_scoped_with_network(
        &self,
        request: CommandRequest,
        authority: CommandExecutionAuthority,
        cancellation: &CancellationToken,
        scope: Option<&SandboxScope>,
        network_policy: Option<&network_proxy::NetworkPolicyHandle>,
    ) -> Result<CommandExecutionOutcome, ExecutionError> {
        self.approve(&request, cancellation)?;
        self.execution
            .execute_scoped_with_network(request, authority, cancellation, scope, network_policy)
            .map_err(Into::into)
    }
    pub fn start_session_scoped_with_network(
        &self,
        request: CommandRequest,
        authority: CommandExecutionAuthority,
        cancellation: &CancellationToken,
        scope: Option<&SandboxScope>,
        network_policy: Option<&network_proxy::NetworkPolicyHandle>,
        owner: CommandSessionOwner,
        options: CommandSessionOptions,
    ) -> Result<CommandSessionStart, ExecutionError> {
        self.approve(&request, cancellation)?;
        self.execution
            .start_session_scoped_with_network(
                request,
                authority,
                cancellation,
                scope,
                network_policy,
                owner.process_owner(),
                options,
            )
            .map_err(Into::into)
    }
    pub fn read_session(
        &self,
        owner: &CommandSessionOwner,
        id: &CommandSessionId,
        cursor: CommandSessionCursor,
        wait_budget: Duration,
    ) -> Result<CommandSessionUpdate, ExecutionError> {
        self.execution
            .read_session(&owner.process_owner(), id, cursor, wait_budget)
            .map_err(Into::into)
    }
    pub async fn wait_session(
        &self,
        owner: &CommandSessionOwner,
        id: &CommandSessionId,
        cursor: CommandSessionCursor,
        wait_budget: Duration,
        cancellation: &CancellationToken,
    ) -> Result<CommandSessionUpdate, ExecutionError> {
        self.execution
            .wait_session(
                &owner.process_owner(),
                id,
                cursor,
                wait_budget,
                cancellation,
            )
            .await
            .map_err(Into::into)
    }
    pub fn write_session(
        &self,
        owner: &CommandSessionOwner,
        id: &CommandSessionId,
        bytes: Vec<u8>,
    ) -> Result<(), ExecutionError> {
        self.execution
            .write_session(&owner.process_owner(), id, bytes)
            .map_err(Into::into)
    }
    pub fn close_session_input(
        &self,
        owner: &CommandSessionOwner,
        id: &CommandSessionId,
    ) -> Result<(), ExecutionError> {
        self.execution
            .close_session_input(&owner.process_owner(), id)
            .map_err(Into::into)
    }
    pub fn interrupt_session(
        &self,
        owner: &CommandSessionOwner,
        id: &CommandSessionId,
    ) -> Result<(), ExecutionError> {
        self.execution
            .interrupt_session(&owner.process_owner(), id)
            .map_err(Into::into)
    }
    pub fn resize_session(
        &self,
        owner: &CommandSessionOwner,
        id: &CommandSessionId,
        size: TerminalSize,
    ) -> Result<(), ExecutionError> {
        self.execution
            .resize_session(&owner.process_owner(), id, size)
            .map_err(Into::into)
    }
    pub fn terminate_session(
        &self,
        owner: &CommandSessionOwner,
        id: &CommandSessionId,
    ) -> Result<(), ExecutionError> {
        self.execution
            .terminate_session(&owner.process_owner(), id)
            .map_err(Into::into)
    }
    pub fn release_session(
        &self,
        owner: &CommandSessionOwner,
        id: &CommandSessionId,
    ) -> Result<(), ExecutionError> {
        self.execution
            .release_session(&owner.process_owner(), id)
            .map_err(Into::into)
    }
}

pub type ToolExecutor<P, B> = CommandExecutor<P, B>;

#[cfg(test)]
#[path = "command_executor_tests.rs"]
mod tests;
