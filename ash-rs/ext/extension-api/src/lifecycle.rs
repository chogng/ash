use crate::ExtensionError;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use extension_items::ExtensionItem;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ThreadLifecycle {
    Created,
    Archived,
    Restored,
    TurnStarted(TurnId),
    TurnCompleted(TurnId),
    TurnFailed(TurnId),
    TurnInterrupted(TurnId),
}

#[derive(Clone, Copy)]
pub struct ThreadContext<'a> {
    pub session_id: &'a SessionId,
    pub thread_id: &'a ThreadId,
    pub sequence: u64,
}

/// Receives committed lifecycle facts, never provisional state or replayed history.
/// Callbacks cannot re-enter Core or veto a committed mutation. Durable side effects must deduplicate
/// by Thread and sequence; an observer is not a second Thread-state owner.
pub trait LifecycleObserver: Send + Sync {
    fn thread_changed(&self, context: ThreadContext<'_>, event: &ThreadLifecycle);
    fn config_changed(&self, generation: u64);
}

/// Schedules extension-owned idle work after a Turn's terminal fact commits.
/// Implementations may wake their domain scheduler, but cannot directly start a Turn or re-enter Core.
/// Hosts must also reconcile durable work at startup; callbacks are not a durable delivery channel.
pub trait IdleContributor: Send + Sync {
    fn contribute(&self, context: ThreadContext<'_>);
}

/// Supplies read-only, text-only items for one authorized Thread view.
/// The host validates bounds and uniqueness; extensions retain ownership of the underlying state.
pub trait ItemContributor: Send + Sync {
    fn contribute(&self, context: ThreadContext<'_>) -> Result<Vec<ExtensionItem>, ExtensionError>;
}

/// A durable extension-owned Turn ready for the host executor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtensionTurn {
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
}

/// Plans extension-owned follow-up work outside the Thread commit lock.
/// Implementations use the Thread owner's atomic admission API and stable command identities;
/// they never execute a model themselves. Recovery must remain safe to repeat.
pub trait ContinuationContributor: Send + Sync {
    fn next_turn(
        &self,
        thread: &ThreadId,
        completed: &TurnId,
    ) -> Result<Option<ExtensionTurn>, ExtensionError>;
    fn recover(
        &self,
        sessions: &std::collections::BTreeSet<SessionId>,
    ) -> Result<Vec<ExtensionTurn>, ExtensionError>;
}

/// Reviews an exact prepared action; only ActionPolicy may turn an assessment into authority.
pub trait ApprovalReviewContributor: Send + Sync {
    fn review(
        &self,
        request: &ash_action_policy::ActionReviewRequest,
        cancellation: &async_utils::CancellationToken,
    ) -> Result<ash_action_policy::ClassifierAssessment, ExtensionError>;
}

/// Facts emitted only after the matching Tool lifecycle event has committed.
#[derive(Clone, Debug)]
pub enum ToolLifecycle {
    Started {
        call_id: ash_protocol::ToolCallId,
        action_digest: String,
        policy_revision: String,
    },
    Completed {
        call_id: ash_protocol::ToolCallId,
        is_error: bool,
    },
}
/// Observes committed Tool outcomes without executing or authorizing another action.
pub trait ToolLifecycleContributor: Send + Sync {
    fn tool_changed(&self, context: ThreadContext<'_>, turn: &TurnId, event: &ToolLifecycle);
}
/// Observes MCP catalog lifecycle; callbacks may invalidate extension-owned caches.
pub trait McpLifecycleContributor: Send + Sync {
    fn catalog_changed(&self, event: &McpLifecycle);
}
#[derive(Clone, Debug)]
pub enum McpLifecycle {
    Started { generation: u64 },
    ToolsChanged,
    Stopped { generation: u64 },
}
