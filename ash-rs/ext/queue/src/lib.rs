//! Durable FIFO messages and leased delivery to the existing Turn owner.

mod extension;
pub use extension::install;
mod runtime;
mod store;
pub use runtime::Delivery;
pub use runtime::QueueExecutor;
pub use runtime::QueueRuntime;
pub use store::QueueStore;

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

#[derive(Debug, thiserror::Error)]
pub enum QueueError {
    #[error("invalid queued message: {0}")]
    Invalid(String),
    #[error("queued message not found")]
    NotFound,
    #[error("queued message conflicts with an accepted command")]
    Conflict,
    #[error("queued message is being delivered")]
    Busy,
    #[error("queue storage failed: {0}")]
    Storage(String),
}

impl From<rusqlite::Error> for QueueError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(error.to_string())
    }
}
impl From<serde_json::Error> for QueueError {
    fn from(error: serde_json::Error) -> Self {
        Self::Storage(error.to_string())
    }
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
