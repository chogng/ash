//! Durable transcript items and plan updates displayed within a Thread Turn.
//! Model request messages are a separate contract in `model/message.rs`.

mod plan;

pub use plan::PlanStep;
pub use plan::PlanStepStatus;
pub use plan::PlanUpdate;

use crate::AudioAttachmentRef;
use crate::CommandId;
use crate::ContentPart;
use crate::ImageAttachmentRef;
use crate::ItemId;
use crate::ToolCallBinding;
use crate::ToolCallId;
use crate::ToolName;
use crate::TurnId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// A normalized, provider-independent item produced or consumed during one Thread turn.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ThreadItem {
    UserAudioAttachment {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        client_id: Option<CommandId>,
        item_id: ItemId,
        turn_id: TurnId,
        attachment: AudioAttachmentRef,
    },
    UserMessage {
        /// The submitting command's ID, shared by all input parts of that submission.
        /// Older stored items have no ID and cannot acknowledge a pending client submission.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        client_id: Option<CommandId>,
        item_id: ItemId,
        turn_id: TurnId,
        text: String,
    },
    UserContext {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        client_id: Option<CommandId>,
        item_id: ItemId,
        turn_id: TurnId,
        name: String,
        content: String,
    },
    UserImage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        client_id: Option<CommandId>,
        item_id: ItemId,
        turn_id: TurnId,
        url: String,
    },
    UserImageAttachment {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        client_id: Option<CommandId>,
        item_id: ItemId,
        turn_id: TurnId,
        attachment: ImageAttachmentRef,
    },
    AgentMessage {
        item_id: ItemId,
        turn_id: TurnId,
        text: String,
    },
    Reasoning {
        item_id: ItemId,
        turn_id: TurnId,
        text: String,
        #[serde(default)]
        state: Vec<crate::ReasoningState>,
    },
    Plan {
        item_id: ItemId,
        turn_id: TurnId,
        text: String,
    },
    ToolCall {
        item_id: ItemId,
        turn_id: TurnId,
        tool_call_id: ToolCallId,
        name: ToolName,
        arguments_json: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        binding: Option<ToolCallBinding>,
    },
    ToolResult {
        item_id: ItemId,
        turn_id: TurnId,
        tool_call_id: ToolCallId,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<Vec<ContentPart>>,
        is_error: bool,
    },
}

impl ThreadItem {
    /// Identifies the client submission that produced this user input part.
    pub fn client_id(&self) -> Option<&CommandId> {
        match self {
            Self::UserMessage { client_id, .. }
            | Self::UserContext { client_id, .. }
            | Self::UserImage { client_id, .. }
            | Self::UserImageAttachment { client_id, .. }
            | Self::UserAudioAttachment { client_id, .. } => client_id.as_ref(),
            Self::AgentMessage { .. }
            | Self::Reasoning { .. }
            | Self::Plan { .. }
            | Self::ToolCall { .. }
            | Self::ToolResult { .. } => None,
        }
    }

    pub fn item_id(&self) -> &ItemId {
        match self {
            Self::UserMessage { item_id, .. }
            | Self::UserContext { item_id, .. }
            | Self::UserImage { item_id, .. }
            | Self::UserImageAttachment { item_id, .. }
            | Self::UserAudioAttachment { item_id, .. }
            | Self::AgentMessage { item_id, .. }
            | Self::Reasoning { item_id, .. }
            | Self::Plan { item_id, .. }
            | Self::ToolCall { item_id, .. }
            | Self::ToolResult { item_id, .. } => item_id,
        }
    }

    pub fn turn_id(&self) -> &TurnId {
        match self {
            Self::UserMessage { turn_id, .. }
            | Self::UserContext { turn_id, .. }
            | Self::UserImage { turn_id, .. }
            | Self::UserImageAttachment { turn_id, .. }
            | Self::UserAudioAttachment { turn_id, .. }
            | Self::AgentMessage { turn_id, .. }
            | Self::Reasoning { turn_id, .. }
            | Self::Plan { turn_id, .. }
            | Self::ToolCall { turn_id, .. }
            | Self::ToolResult { turn_id, .. } => turn_id,
        }
    }
}
