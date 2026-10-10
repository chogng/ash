//! Thread state, commands, durable events, and subscriber updates for one execution branch.
//! Core owns state reduction; persistence owns event storage and sequence allocation.

use crate::ModelReferenceCostSummary;
use crate::ModelUsageSummary;
use crate::SessionId;
use crate::ThreadId;
use crate::Turn;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

mod command;
mod context_checkpoint;
mod event;
mod goal;
mod history;
mod status;
mod update;

pub use command::ThreadCommand;
pub use context_checkpoint::ContextCheckpoint;
pub use context_checkpoint::ContextCheckpointVerification;
pub use context_checkpoint::ContextSourceDigest;
pub use context_checkpoint::ContextSourceRange;
pub use context_checkpoint::InvalidContextSourceDigest;
pub use event::ThreadEvent;
pub use event::ToolExecutionAuthority;
pub use goal::ThreadGoal;
pub use goal::ThreadGoalStatus;
pub use goal::UserGoalChange;
pub use history::HistoryPrefixRef;
pub use history::MessageBoundary;
pub use history::MessageCheckpoint;
pub use history::RepositoryCheckpoint;
pub use history::WorkspaceCheckpoint;
pub use status::ThreadArchiveReason;
pub use status::ThreadStatus;
pub use update::ItemDelta;
pub use update::ThreadUpdate;
pub use update::ThreadUpdateEnvelope;
pub use update::ToolOutputStream;

/// Canonical readable state for one independently ordered Agent execution branch.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub agent_id: crate::AgentId,
    pub origin: crate::ThreadOrigin,
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub parent_thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub forked_from_id: Option<ThreadId>,
    pub title: String,
    pub status: ThreadStatus,
    #[ts(type = "number")]
    pub sequence: u64,
    #[serde(default)]
    pub usage: ModelUsageSummary,
    #[serde(default)]
    pub reference_cost: ModelReferenceCostSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub goal: Option<ThreadGoal>,
    #[serde(default)]
    pub advisor: crate::AdvisorSelection,
    pub turns: Vec<Turn>,
    #[serde(default)]
    pub hook_runs: Vec<crate::HookRunRecord>,
}
