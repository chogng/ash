use crate::protocol::turn::InputItem;
use ash_protocol::ApprovalMode;
use ash_protocol::CommandId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ToolMode;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueEnqueueParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub input: Vec<InputItem>,
    pub tool_mode: ToolMode,
    pub approval_mode: ApprovalMode,
}
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueListParams {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
}
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueCancelParams {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub command_id: CommandId,
}
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QueueListResult {
    pub messages: Vec<queue::QueuedMessage>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueEditParams {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: i64,
    pub action: QueueEditAction,
}
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum QueueEditAction {
    Pause,
    Replace {
        input: Vec<InputItem>,
    },
    Move {
        direction: queue::QueueMove,
    },
    Send {
        turn_id: Option<ash_protocol::TurnId>,
    },
}
