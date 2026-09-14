mod plan;

pub use plan::PlanStep;
pub use plan::PlanStepStatus;
pub use plan::PlanUpdate;

use crate::ContentPart;
use crate::ImageAttachmentRef;
use crate::InstructionRef;
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
    UserMessage {
        item_id: ItemId,
        turn_id: TurnId,
        text: String,
    },
    UserContext {
        item_id: ItemId,
        turn_id: TurnId,
        name: String,
        content: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_path: Option<std::path::PathBuf>,
    },
    UserInstruction {
        item_id: ItemId,
        turn_id: TurnId,
        reference: InstructionRef,
    },
    UserImage {
        item_id: ItemId,
        turn_id: TurnId,
        url: String,
    },
    UserImageAttachment {
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
    pub fn item_id(&self) -> &ItemId {
        match self {
            Self::UserMessage { item_id, .. }
            | Self::UserContext { item_id, .. }
            | Self::UserInstruction { item_id, .. }
            | Self::UserImage { item_id, .. }
            | Self::UserImageAttachment { item_id, .. }
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
            | Self::UserInstruction { turn_id, .. }
            | Self::UserImage { turn_id, .. }
            | Self::UserImageAttachment { turn_id, .. }
            | Self::AgentMessage { turn_id, .. }
            | Self::Reasoning { turn_id, .. }
            | Self::Plan { turn_id, .. }
            | Self::ToolCall { turn_id, .. }
            | Self::ToolResult { turn_id, .. } => turn_id,
        }
    }
}
