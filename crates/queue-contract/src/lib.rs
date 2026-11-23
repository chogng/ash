//! Shared queue contracts, independent of execution and storage.

use protocol::ApprovalMode;
use protocol::CommandId;
use protocol::CommandInterpretation;
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
    /// Retains the submitting window when delivery outlives its connection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub window: Option<protocol::WorkbenchWindow>,
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    /// Local execution directory selected at admission. Profile-hosted messages have no directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub directory: Option<String>,
    #[serde(default, skip_serializing_if = "CommandInterpretation::is_product")]
    pub command_interpretation: CommandInterpretation,
    pub input: Vec<UserInput>,
    /// Retained so requests enqueued by an older composer preserve their scope.
    #[serde(default, skip_serializing_if = "protocol::AgentMode::is_agent")]
    pub mode: protocol::AgentMode,
    /// The explicit task command resolved at enqueue or edit time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub task_command: Option<protocol::AgentMode>,
    #[serde(default)]
    pub model: Option<protocol::ModelRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_routing: Option<protocol::ModelRoutingMode>,
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
    /// Return a paused message to its existing FIFO position.
    Resume,
    /// Change user text without reconstructing frozen attachments or tool selection.
    ReplaceText {
        text: String,
        task_command: Option<protocol::AgentMode>,
        command_interpretation: Option<CommandInterpretation>,
    },
    /// Save text and its delivery intent in one revision, retaining frozen non-text input.
    ReplaceTextWithDelivery {
        text: String,
        delivery: QueueDelivery,
        task_command: Option<protocol::AgentMode>,
        command_interpretation: Option<CommandInterpretation>,
    },
    Replace {
        input: Vec<UserInput>,
        task_command: Option<protocol::AgentMode>,
        command_interpretation: Option<CommandInterpretation>,
    },
    Move {
        direction: QueueMove,
    },
    Send {
        turn_id: Option<TurnId>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum QueueDelivery {
    Queued,
    Immediate,
    Steering { turn_id: TurnId },
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum QueueMove {
    Up,
    Down,
}
