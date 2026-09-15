//! Approved local process execution as one model-visible tool.
//!
//! This crate owns the `shell-command` schema and executor. It delegates process approval,
//! sandbox enforcement, output capture, timeout enforcement, and working-directory containment to
//! `ash-tool-executor`.

mod ripgrep;

pub use ripgrep::{
    BuiltInRipgrepPolicy, RipgrepDiscoveryError, RipgrepExecutable, RipgrepRequestError,
};

use ash_async_utils::CancellationToken;
use ash_file_access::Dir;
use ash_sandboxing::SandboxBackend;
use ash_sandboxing::SandboxScope;
use ash_tool_executor::CommandExecutor;
use ash_tool_executor::CommandInput;
use ash_tool_executor::CommandRequest;
use ash_tools::{
    ToolConcurrency, ToolDefinition, ToolExecutionFuture, ToolExecutionOutcome, ToolExecutor,
    ToolInputSchema, ToolInvocation, ToolLoading, ToolName, ToolOutput, ToolOutputSchema,
    ToolPayload, ToolRuntimeAuthority, ToolSchemaMode, ToolStartFailure,
};
use serde::Deserialize;
use serde_json::json;
use std::fmt;
use std::future;
use std::path::PathBuf;

pub use ash_tool_executor::{
    ApprovalPolicy, ApprovalRequirement, CommandExecutionAuthority, CommandExecutionOutcome,
    CommandSessionCursor, CommandSessionId, CommandSessionOptions, CommandSessionOwner,
    CommandSessionStart, CommandSessionStatus, CommandSessionUpdate, CommandTerminalSize,
    ExecutionError, ExecutionLimits as ShellCommandLimits,
};

/// Error raised while constructing the shell-command executor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ShellCommandToolError {
    Definition(String),
    InvalidArguments(String),
}

impl fmt::Display for ShellCommandToolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Definition(message) => formatter.write_str(message),
            Self::InvalidArguments(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for ShellCommandToolError {}

/// Executes one approved local process with an explicit program, arguments, and dir path.
///
/// The selected environment ID must match the immutable ID configured at construction. The
/// executor never starts a shell implicitly: callers must choose the program they intend to run.
pub struct ShellCommandTool<P, B> {
    environment_id: ash_tools::EnvId,
    executor: CommandExecutor<P, B>,
    definition: ToolDefinition,
}

impl<P: ApprovalPolicy, B: SandboxBackend> ShellCommandTool<P, B> {
    pub fn new(
        environment_id: ash_tools::EnvId,
        dir: Dir,
        backend: B,
        approval_policy: P,
        limits: ShellCommandLimits,
    ) -> Result<Self, ShellCommandToolError> {
        Ok(Self {
            environment_id,
            executor: CommandExecutor::new(dir, backend, approval_policy, limits),
            definition: shell_command_definition()?,
        })
    }

    /// Returns the immutable host definition used to bind this executor.
    pub fn host_definition(&self) -> &ToolDefinition {
        &self.definition
    }

    /// Executes one already materialized request under authority selected by the host.
    pub fn execute_authorized(
        &self,
        request: ShellCommandRequest,
        authority: CommandExecutionAuthority,
        cancellation: &CancellationToken,
    ) -> Result<CommandExecutionOutcome, ExecutionError> {
        self.execute_authorized_scoped(request, authority, cancellation, None)
    }

    /// Executes with an optional host-owned multi-directory visibility boundary.
    pub fn execute_authorized_scoped(
        &self,
        request: ShellCommandRequest,
        authority: CommandExecutionAuthority,
        cancellation: &CancellationToken,
        scope: Option<&SandboxScope>,
    ) -> Result<CommandExecutionOutcome, ExecutionError> {
        self.execute_authorized_with_network(request, authority, cancellation, scope, None)
    }

    /// Executes with the host's request authority and the same process sandbox throughout.
    pub fn execute_authorized_with_network(
        &self,
        request: ShellCommandRequest,
        authority: CommandExecutionAuthority,
        cancellation: &CancellationToken,
        scope: Option<&SandboxScope>,
        network_policy: Option<&network_proxy::NetworkPolicyHandle>,
    ) -> Result<CommandExecutionOutcome, ExecutionError> {
        let dir = request
            .dir_root()
            .map(Dir::open_local)
            .transpose()
            .map_err(|error| ExecutionError::Spawn(error.to_string()))?;
        if scope.is_some() && dir.is_none() {
            return Err(ExecutionError::Spawn(
                "sandbox scope requires an exact command directory".into(),
            ));
        }
        if let (Some(dir), Some(scope)) = (&dir, scope)
            && dir != scope.command_dir()
        {
            return Err(ExecutionError::Spawn(
                "sandbox command directory does not match the materialized request".into(),
            ));
        }
        let owned_scope = scope
            .is_none()
            .then(|| dir.clone().map(SandboxScope::single))
            .flatten();
        self.executor.execute_scoped_with_network(
            CommandRequest {
                program: request.program,
                arguments: request.arguments,
                working_directory: request.working_directory,
                input: CommandInput::Closed,
            },
            authority,
            cancellation,
            scope.or(owned_scope.as_ref()),
            network_policy,
        )
    }

    pub fn start_authorized_session_with_network(
        &self,
        request: ShellCommandRequest,
        authority: CommandExecutionAuthority,
        cancellation: &CancellationToken,
        scope: Option<&SandboxScope>,
        network_policy: Option<&network_proxy::NetworkPolicyHandle>,
        owner: CommandSessionOwner,
        options: ash_tool_executor::CommandSessionOptions,
    ) -> Result<CommandSessionStart, ExecutionError> {
        let dir = request
            .dir_root()
            .map(Dir::open_local)
            .transpose()
            .map_err(|error| ExecutionError::Spawn(error.to_string()))?;
        if let (Some(dir), Some(scope)) = (&dir, scope)
            && dir != scope.command_dir()
        {
            return Err(ExecutionError::Spawn(
                "sandbox command directory does not match the materialized request".into(),
            ));
        }
        self.executor.start_session_scoped_with_network(
            CommandRequest {
                program: request.program,
                arguments: request.arguments,
                working_directory: request.working_directory,
                input: CommandInput::Open,
            },
            authority,
            cancellation,
            scope,
            network_policy,
            owner,
            options,
        )
    }

    pub fn read_session(
        &self,
        owner: &CommandSessionOwner,
        id: &CommandSessionId,
        cursor: CommandSessionCursor,
        wait_budget: std::time::Duration,
    ) -> Result<CommandSessionUpdate, ExecutionError> {
        self.executor.read_session(owner, id, cursor, wait_budget)
    }

    /// Observes completion of an existing command without rerunning it or returning progress.
    pub async fn wait_session(
        &self,
        owner: &CommandSessionOwner,
        id: &CommandSessionId,
        cursor: CommandSessionCursor,
        wait_budget: std::time::Duration,
        cancellation: &CancellationToken,
    ) -> Result<CommandSessionUpdate, ExecutionError> {
        self.executor
            .wait_session(owner, id, cursor, wait_budget, cancellation)
            .await
    }

    pub fn write_session(
        &self,
        owner: &CommandSessionOwner,
        id: &CommandSessionId,
        bytes: Vec<u8>,
    ) -> Result<(), ExecutionError> {
        self.executor.write_session(owner, id, bytes)
    }

    pub fn close_session_input(
        &self,
        owner: &CommandSessionOwner,
        id: &CommandSessionId,
    ) -> Result<(), ExecutionError> {
        self.executor.close_session_input(owner, id)
    }

    pub fn interrupt_session(
        &self,
        owner: &CommandSessionOwner,
        id: &CommandSessionId,
    ) -> Result<(), ExecutionError> {
        self.executor.interrupt_session(owner, id)
    }

    pub fn terminate_session(
        &self,
        owner: &CommandSessionOwner,
        id: &CommandSessionId,
    ) -> Result<(), ExecutionError> {
        self.executor.terminate_session(owner, id)
    }

    pub fn resize_session(
        &self,
        owner: &CommandSessionOwner,
        id: &CommandSessionId,
        size: CommandTerminalSize,
    ) -> Result<(), ExecutionError> {
        self.executor.resize_session(owner, id, size)
    }

    fn run(&self, invocation: ToolInvocation) -> ToolExecutionOutcome {
        if invocation.context().environment_id() != &self.environment_id {
            return not_started("tool invocation selected a different local environment");
        }
        let authority = match invocation.context().authority() {
            ToolRuntimeAuthority::Sandboxed(policy) => CommandExecutionAuthority::Sandboxed(policy),
            ToolRuntimeAuthority::Unrestricted => CommandExecutionAuthority::Unrestricted,
        };
        if let Err(outcome) = validate_invocation(&self.definition, &invocation) {
            return outcome;
        }
        let input = match ShellCommandRequest::from_arguments(invocation.payload()) {
            Ok(input) => input,
            Err(error) => return returned_error(error.to_string()),
        };

        match self.execute_authorized_with_network(
            input,
            authority,
            invocation.context().cancellation(),
            invocation.context().sandbox_scope(),
            invocation.context().network_policy(),
        ) {
            Ok(CommandExecutionOutcome::Completed(output)) => {
                let mut value = json!({
                    "tool": "shell-command",
                    "result": {
                        "exit_code": output.exit_code,
                        "stdout": output.stdout,
                        "stderr": output.stderr,
                        "stdout_truncated": output.stdout_truncated,
                        "stderr_truncated": output.stderr_truncated,
                    }
                });
                if invocation.context().sandbox_scope().is_some()
                    && matches!(authority, CommandExecutionAuthority::Sandboxed(policy) if policy.file_system() == ash_sandboxing::FileSystemAccess::DirectoryWrite && policy.network() == ash_sandboxing::NetworkAccess::Denied)
                {
                    value["result"]["managed_scope"] = true.into();
                }
                returned_json(value)
            }
            Ok(CommandExecutionOutcome::SandboxDenied(denial)) => {
                ToolExecutionOutcome::SandboxDenied(denial)
            }
            Err(ExecutionError::CancelledBeforeStart(message)) => not_started(format!(
                "command was cancelled before it started: {message}"
            )),
            Err(ExecutionError::CancelledAfterStart(message)) => {
                ToolExecutionOutcome::OutcomeUncertain(ash_tools::ToolUncertainOutcome::new(
                    format!("command was cancelled after it started: {message}"),
                ))
            }
            Err(ExecutionError::TimedOut) => ToolExecutionOutcome::OutcomeUncertain(
                ash_tools::ToolUncertainOutcome::new("command timed out after it started"),
            ),
            Err(error) => returned_error(command_error_message(error)),
        }
    }
}

impl<P: ApprovalPolicy, B: SandboxBackend> ToolExecutor for ShellCommandTool<P, B> {
    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Exclusive
    }

    fn execute(&self, invocation: ToolInvocation) -> ToolExecutionFuture<'_> {
        Box::pin(future::ready(self.run(invocation)))
    }
}

/// Canonical explicit-process request accepted by [`ShellCommandTool`].
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ShellCommandRequest {
    program: String,
    arguments: Vec<String>,
    working_directory: PathBuf,
    #[serde(default)]
    dir_root: Option<PathBuf>,
}

impl ShellCommandRequest {
    /// Creates a request without invoking a shell or expanding arguments.
    pub fn new(
        program: impl Into<String>,
        arguments: impl IntoIterator<Item = impl Into<String>>,
        working_directory: impl Into<PathBuf>,
    ) -> Result<Self, ShellCommandToolError> {
        let program = program.into();
        if program.trim().is_empty() {
            return Err(ShellCommandToolError::InvalidArguments(
                "program must not be empty".into(),
            ));
        }
        Ok(Self {
            program,
            arguments: arguments.into_iter().map(Into::into).collect(),
            working_directory: working_directory.into(),
            dir_root: None,
        })
    }

    /// Decodes the model-visible function payload into one canonical request.
    pub fn from_arguments(payload: &ToolPayload) -> Result<Self, ShellCommandToolError> {
        let ToolPayload::FunctionArguments(arguments) = payload else {
            return Err(ShellCommandToolError::InvalidArguments(
                "tool requires structured function arguments".into(),
            ));
        };
        let decoded: Self = serde_json::from_value(arguments.clone()).map_err(|error| {
            ShellCommandToolError::InvalidArguments(format!("invalid tool arguments: {error}"))
        })?;
        let mut request = Self::new(
            decoded.program,
            decoded.arguments,
            decoded.working_directory,
        )?;
        request.dir_root = decoded.dir_root;
        Ok(request)
    }

    pub fn program(&self) -> &str {
        &self.program
    }

    pub fn arguments(&self) -> &[String] {
        &self.arguments
    }

    pub fn working_directory(&self) -> &std::path::Path {
        &self.working_directory
    }

    pub fn dir_root(&self) -> Option<&std::path::Path> {
        self.dir_root.as_deref()
    }

    pub fn with_dir_root(mut self, dir_root: impl Into<PathBuf>) -> Self {
        self.dir_root = Some(dir_root.into());
        self
    }

    pub fn with_working_directory(mut self, working_directory: impl Into<PathBuf>) -> Self {
        self.working_directory = working_directory.into();
        self
    }

    pub(crate) fn replace_program_and_arguments(
        self,
        program: String,
        arguments: Vec<String>,
    ) -> Self {
        Self {
            program,
            arguments,
            working_directory: self.working_directory,
            dir_root: self.dir_root,
        }
    }
}

/// Builds the model-visible host definition for the explicit process tool.
pub fn shell_command_definition() -> Result<ToolDefinition, ShellCommandToolError> {
    ToolDefinition::function(
        ToolName::new("shell-command").map_err(definition_error)?,
        "Run one approved command in a dir directory. Pass the program and each argument separately; no shell is started implicitly.",
        ToolInputSchema::parse(json!({
            "type": "object",
            "properties": {
                "program": { "type": "string", "description": "Program to execute." },
                "arguments": { "type": "array", "items": { "type": "string" }, "description": "Arguments passed to the program in order." },
                "working_directory": { "type": "string", "description": "Directory used as the process working directory. Use an absolute path for an authorized directory." }
            },
            "required": ["program", "arguments", "working_directory"],
            "additionalProperties": false
        }))
        .map_err(definition_error)?,
        ToolOutputSchema::Unspecified,
        ToolSchemaMode::ProviderDefault,
        ToolLoading::Eager,
    )
    .map_err(definition_error)
}

fn definition_error(error: impl fmt::Display) -> ShellCommandToolError {
    ShellCommandToolError::Definition(error.to_string())
}

fn validate_invocation(
    definition: &ToolDefinition,
    invocation: &ToolInvocation,
) -> Result<(), ToolExecutionOutcome> {
    if invocation.context().cancellation().is_cancelled() {
        return Err(not_started(
            "tool invocation was cancelled before it started",
        ));
    }
    if invocation.binding().exposed_name() != definition.name()
        || invocation.binding().definition_digest() != &definition.digest()
    {
        return Err(not_started(
            "tool binding does not match this executor definition",
        ));
    }
    Ok(())
}

fn returned_error(message: impl Into<String>) -> ToolExecutionOutcome {
    ToolExecutionOutcome::Returned(ToolOutput::error(vec![ash_tools::ToolContent::Text(
        message.into(),
    )]))
}

fn returned_json(value: serde_json::Value) -> ToolExecutionOutcome {
    match serde_json::to_string_pretty(&value) {
        Ok(text) => {
            ToolExecutionOutcome::Returned(ToolOutput::success(vec![ash_tools::ToolContent::Text(
                text,
            )]))
        }
        Err(error) => returned_error(format!("could not encode tool output: {error}")),
    }
}

fn not_started(message: impl Into<String>) -> ToolExecutionOutcome {
    ToolExecutionOutcome::NotStarted(ToolStartFailure::new(message))
}

fn command_error_message(error: ExecutionError) -> String {
    match error {
        ExecutionError::Network(message) => format!("shell command network failed: {message}"),
        ExecutionError::ApprovalRequired => "command requires approval".to_owned(),
        ExecutionError::Denied => "command execution is denied by policy".to_owned(),
        ExecutionError::Spawn(message) => format!("could not execute command: {message}"),
        ExecutionError::CancelledBeforeStart(message) => {
            format!("command was cancelled before it started: {message}")
        }
        ExecutionError::CancelledAfterStart(message) => {
            format!("command was cancelled after it started: {message}")
        }
        ExecutionError::TimedOut => "command exceeded its configured timeout".to_owned(),
        ExecutionError::Sandbox(error) => {
            format!("command working directory is not allowed: {error}")
        }
    }
}

#[cfg(test)]
#[path = "shell_command_tests.rs"]
mod tests;
