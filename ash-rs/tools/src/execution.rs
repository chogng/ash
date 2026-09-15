use crate::{EnvId, ToolBinding, ToolCallId, ToolDefinition, ToolOperationId, ToolOutput};
use ash_async_utils::CancellationToken;
use ash_protocol::SandboxDenialOutput;
use ash_protocol::TurnId;
use ash_sandboxing::SandboxPolicy;
use ash_sandboxing::SandboxScope;
use serde_json::Value;
use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;

/// Controls whether an executor enters the initial model tool set, deferred search, or neither.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolExposure {
    Direct,
    Deferred,
    DirectModelOnly,
    Hidden,
}

/// Canonical payload shapes accepted by a fully materialized host tool invocation.
#[derive(Clone, Debug, PartialEq)]
pub enum ToolPayload {
    FunctionArguments(Value),
    FreeformInput(String),
}

/// Declares whether independently materialized calls may run concurrently.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolConcurrency {
    Exclusive,
    ParallelSafe,
    ConflictClass(ToolConflictClass),
}

/// A host-defined conflict domain used by Core when it plans concurrent tool calls.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ToolConflictClass(String);

impl ToolConflictClass {
    pub fn new(value: impl Into<String>) -> Result<Self, crate::ToolIdentityError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(crate::ToolIdentityError::Empty {
                kind: "tool conflict class",
            });
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The host environment selected for one invocation without exposing a raw capability map.
#[derive(Clone, Debug)]
pub struct ToolExecutionContext {
    environment_id: EnvId,
    cancellation: CancellationToken,
    authority: ToolRuntimeAuthority,
    session_id: Option<ash_protocol::SessionId>,
    thread_id: Option<ash_protocol::ThreadId>,
    execution_dir: Option<PathBuf>,
    sandbox_scope: Option<SandboxScope>,
    network_policy: Option<network_proxy::NetworkPolicyHandle>,
}

/// Exact runtime boundary selected by policy for one materialized tool invocation.
///
/// Hosts must create a fresh value for each Tool Call. Executors that start subprocesses must
/// translate `Sandboxed` into platform enforcement and must not infer unrestricted execution from
/// an allow-list or approval result.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolRuntimeAuthority {
    Sandboxed(SandboxPolicy),
    Unrestricted,
}

impl ToolExecutionContext {
    pub fn new(
        environment_id: EnvId,
        cancellation: CancellationToken,
        authority: ToolRuntimeAuthority,
    ) -> Self {
        Self {
            environment_id,
            cancellation,
            authority,
            session_id: None,
            thread_id: None,
            execution_dir: None,
            sandbox_scope: None,
            network_policy: None,
        }
    }

    pub fn with_session_id(mut self, session_id: ash_protocol::SessionId) -> Self {
        self.session_id = Some(session_id);
        self
    }

    /// Binds the durable Thread identity selected by the host, never model arguments.
    pub fn with_thread_id(mut self, thread_id: ash_protocol::ThreadId) -> Self {
        self.thread_id = Some(thread_id);
        self
    }

    pub fn thread_id(&self) -> Option<&ash_protocol::ThreadId> {
        self.thread_id.as_ref()
    }

    /// Binds one host-selected directory to this exact invocation.
    pub fn with_execution_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.execution_dir = Some(dir.into());
        self
    }

    /// Binds host-owned directory visibility to this exact invocation.
    pub fn with_sandbox_scope(mut self, scope: SandboxScope) -> Self {
        self.sandbox_scope = Some(scope);
        self
    }

    pub fn with_network_policy(mut self, policy: network_proxy::NetworkPolicyHandle) -> Self {
        self.network_policy = Some(policy);
        self
    }

    pub fn network_policy(&self) -> Option<&network_proxy::NetworkPolicyHandle> {
        self.network_policy.as_ref()
    }

    pub fn session_id(&self) -> Option<&ash_protocol::SessionId> {
        self.session_id.as_ref()
    }

    pub fn execution_dir(&self) -> Option<&Path> {
        self.execution_dir.as_deref()
    }

    pub fn environment_id(&self) -> &EnvId {
        &self.environment_id
    }

    pub fn cancellation(&self) -> &CancellationToken {
        &self.cancellation
    }

    pub fn authority(&self) -> ToolRuntimeAuthority {
        self.authority
    }

    pub fn sandbox_scope(&self) -> Option<&SandboxScope> {
        self.sandbox_scope.as_ref()
    }
}

/// A model call resolved to its frozen binding, execution identity, and selected environment.
#[derive(Clone, Debug)]
pub struct ToolInvocation {
    operation_id: ToolOperationId,
    call_id: ToolCallId,
    turn_id: TurnId,
    binding: ToolBinding,
    payload: ToolPayload,
    context: ToolExecutionContext,
}

impl ToolInvocation {
    pub fn new(
        operation_id: ToolOperationId,
        call_id: ToolCallId,
        turn_id: TurnId,
        binding: ToolBinding,
        payload: ToolPayload,
        context: ToolExecutionContext,
    ) -> Self {
        Self {
            operation_id,
            call_id,
            turn_id,
            binding,
            payload,
            context,
        }
    }

    pub fn operation_id(&self) -> &ToolOperationId {
        &self.operation_id
    }

    pub fn call_id(&self) -> &ToolCallId {
        &self.call_id
    }

    pub fn turn_id(&self) -> &TurnId {
        &self.turn_id
    }

    pub fn binding(&self) -> &ToolBinding {
        &self.binding
    }

    pub fn payload(&self) -> &ToolPayload {
        &self.payload
    }

    pub fn context(&self) -> &ToolExecutionContext {
        &self.context
    }
}

/// A failure that proves the tool operation did not begin outside the host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolStartFailure {
    message: String,
}

impl ToolStartFailure {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

/// An outcome where an external side effect may have begun but no trustworthy result is available.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolUncertainOutcome {
    message: String,
}

impl ToolUncertainOutcome {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

/// The source-neutral terminal state reported by a tool executor.
///
/// `SandboxDenied` preserves the protocol-owned process result for Core review. Executors must
/// use it only when their selected platform backend recognized enforcement, and may mark it
/// `SafeToRetry` only when the requested action never began.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolExecutionOutcome {
    Returned(ToolOutput),
    NotStarted(ToolStartFailure),
    SandboxDenied(SandboxDenialOutput),
    OutcomeUncertain(ToolUncertainOutcome),
}

/// Future returned by a tool executor after a fully materialized invocation.
pub type ToolExecutionFuture<'a> = Pin<Box<dyn Future<Output = ToolExecutionOutcome> + Send + 'a>>;

/// Executes one fully materialized host tool invocation.
///
/// Implementations must execute only the supplied binding and payload, use only capabilities
/// selected by the host environment, preserve call and operation identity, and never mutate
/// Thread state. Cancellation, deadlines, and durable outcome handling are layered by the Core
/// service that calls the executor.
pub trait ToolExecutor: Send + Sync {
    /// Returns immutable metadata captured when the host builds a registry snapshot.
    fn definition(&self) -> ToolDefinition;

    /// Declares how the host initially exposes this executor to a model.
    fn exposure(&self) -> crate::ToolExposure {
        crate::ToolExposure::Direct
    }

    /// Declares the executor's concurrency constraints for Core scheduling.
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Exclusive
    }

    /// Executes exactly one invocation without directly committing durable state.
    fn execute(&self, invocation: ToolInvocation) -> ToolExecutionFuture<'_>;
}

#[cfg(test)]
#[path = "execution_tests.rs"]
mod tests;
