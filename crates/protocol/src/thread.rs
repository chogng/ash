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
pub use history::HistoryDirection;
pub use history::HistoryPrefixRef;
pub use history::MessageBoundary;
pub use history::MessageCheckpoint;
pub use history::RepositoryCheckpoint;
pub use history::ThreadHistoryCheckpoint;
pub use history::ThreadHistoryState;
pub use history::WorkspaceCheckpoint;
pub use status::ThreadArchiveReason;
pub use status::ThreadStatus;
pub use update::ItemDelta;
pub use update::ThreadUpdate;
pub use update::ThreadUpdateEnvelope;
pub use update::ToolOutputStream;

/// Explicit user names are authoritative over delayed automatic title suggestions.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ThreadTitleSource {
    Automatic,
    #[default]
    Manual,
}

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

/// The authorized media source of a transcript, distinct from an execution/model message role.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum VoiceTranscriptSpeaker {
    User,
    Assistant,
}

/// One canonical voice transcript span. It grants no tool or model instruction authority.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTranscript {
    pub item_id: crate::ItemId,
    pub voice_session_id: String,
    #[ts(type = "number")]
    pub media_epoch: u64,
    pub speaker: VoiceTranscriptSpeaker,
    pub text: String,
    #[ts(type = "number")]
    pub start_ms: u64,
    #[ts(type = "number")]
    pub end_ms: u64,
    /// Places a speech span after its original chronological Thread item on reload.
    pub after_item_id: Option<crate::ItemId>,
}
