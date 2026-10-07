//! Shared queue contracts, independent of execution and storage.

use protocol::ApprovalMode;
use protocol::CommandId;
use protocol::SessionId;
use protocol::ThreadId;
use protocol::ToolMode;
use protocol::TurnId;
use protocol::UserInput;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueInput {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    /// Execution directory selected by the host when accepting the message.
    pub directory: String,
    pub input: Vec<UserInput>,
    #[serde(default)]
    pub mode: protocol::CollaborationMode,
    #[serde(default)]
    pub model: Option<protocol::ModelRef>,
    #[serde(default)]
    pub reasoning_effort: Option<protocol::ReasoningEffort>,
    pub tool_mode: ToolMode,
    pub approval_mode: ApprovalMode,
    #[serde(default)]
    pub steer_turn: Option<TurnId>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum QueueStatus {
    Pending,
    Paused,
    Delivering,
    Started,
    Rejected,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessage {
    pub request: QueueInput,
    pub status: QueueStatus,
    pub turn_id: Option<TurnId>,
    pub error: Option<String>,
    #[ts(type = "number")]
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum QueueEdit {
    Pause,
    Replace { input: Vec<UserInput> },
    Move { direction: QueueMove },
    Send { turn_id: Option<TurnId> },
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum QueueMove {
    Up,
    Down,
}
