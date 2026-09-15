use crate::CoreError;
use ash_async_utils::CancellationToken;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ToolCallId;
use ash_protocol::TurnId;

/// One configured Hook process crossing its execution boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HookExecutionEvent {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub hook_id: String,
    pub dir: std::path::PathBuf,
}

/// Host observer for assigning Hook process writes to the matching Turn.
pub trait HookExecutionObserver: Send + Sync {
    fn will_execute(&self, _: &HookExecutionEvent) -> Result<(), CoreError> {
        Ok(())
    }

    fn did_finish(&self, _: &HookExecutionEvent) {}
}

pub struct NoHookExecutionObserver;

impl HookExecutionObserver for NoHookExecutionObserver {}

/// Canonical request evaluated before a Tool crosses its execution boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BeforeToolHookRequest {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub tool_call_id: ToolCallId,
    pub tool_name: String,
}

/// Decision produced by configured Hooks before Tool execution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BeforeToolHookDecision {
    Continue,
    Deny { reason: String },
}

/// Canonical request observed after a Tool result has been committed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AfterToolHookRequest {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub tool_call_id: ToolCallId,
    pub tool_name: String,
    pub outcome: ToolExecutionOutcome,
}

/// Terminal Tool outcome exposed to an `afterTool` Hook without raw provider output.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolExecutionOutcome {
    Succeeded,
    Failed,
}

/// Canonical request observed after durable Turn completion.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnCompletedHookRequest {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
}

/// Executes Hook work at Core-owned safe-points.
///
/// Implementations must resolve configuration from an immutable runtime snapshot, preserve Hook
/// identity and event ordering, enforce policy before process start, bound input and output, and
/// observe the supplied cancellation token. A `before_tool` denial is returned as a typed decision
/// so Core can persist model-visible Tool feedback without turning it into a failed Turn.
pub trait HookService: Send + Sync {
    fn before_tool(
        &self,
        request: &BeforeToolHookRequest,
        cancellation: &CancellationToken,
    ) -> Result<BeforeToolHookDecision, CoreError>;

    fn after_tool(
        &self,
        request: &AfterToolHookRequest,
        cancellation: &CancellationToken,
    ) -> Result<(), CoreError>;

    /// Runs best-effort work after the durable completion commit.
    ///
    /// Callers must not reopen or rewrite the completed Turn when this method fails.
    fn turn_completed(
        &self,
        request: &TurnCompletedHookRequest,
        cancellation: &CancellationToken,
    ) -> Result<(), CoreError>;
}
