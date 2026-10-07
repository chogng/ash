use crate::CoreError;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ToolCallId;
use ash_protocol::ToolName;
use ash_protocol::TurnId;

/// Identity supplied before any model or Tool step of one Turn execution begins.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnExecutionStarted {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub kind: TurnExecutionKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TurnExecutionKind {
    Agent,
    Shell,
    ContextCompaction,
}

/// Terminal state observed only after Core has committed the matching Thread event and hooks ran.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TurnExecutionTerminalState {
    Completed,
    Failed,
    Interrupted,
}

/// Identity and terminal state supplied when one Turn execution can be sealed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnExecutionFinished {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub terminal_state: TurnExecutionTerminalState,
}

/// Exact Tool lifecycle observed after the service call has returned and before a Turn can seal.
#[derive(Clone, Debug, PartialEq)]
pub struct TurnToolExecutionFinished {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub tool_call_id: ToolCallId,
    pub name: ToolName,
    pub arguments: serde_json::Value,
    pub outcome_unknown: bool,
}

/// Tool identity checked after the durable Tool Call exists but before any service side effect.
#[derive(Clone, Debug, PartialEq)]
pub struct TurnToolExecutionStarted {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub tool_call_id: ToolCallId,
    pub name: ToolName,
    pub arguments: serde_json::Value,
    /// Whether the host-canonical action requests file-write authority.
    pub write_capable: bool,
}

/// Host boundary for durable Turn change checkpoints.
///
/// `will_execute` is fail-closed: returning an error prevents model and Tool execution. Repeated
/// calls for a resumed Turn must be idempotent. `did_finish` must retain sealing failures in the
/// host ledger rather than rewriting the already committed terminal Thread state.
pub trait TurnExecutionObserver: Send + Sync {
    fn will_execute(&self, event: &TurnExecutionStarted) -> Result<(), CoreError>;

    fn did_finish(&self, event: &TurnExecutionFinished);

    fn tool_will_execute(&self, _: &TurnToolExecutionStarted) -> Result<(), CoreError> {
        Ok(())
    }

    fn tool_did_finish(&self, _: &TurnToolExecutionFinished) {}
}
