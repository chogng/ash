use crate::protocol::common::TurnId;
use ash_protocol::ImageAttachmentRef;
use ash_protocol::InstructionRef;
use ash_protocol::SkillRef;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::path::PathBuf;
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum InputItem {
    /// Resolves an issue from the receiving Session's durable issue-task association.
    Issue {
        #[ts(type = "number")]
        number: u64,
    },
    Text {
        text: String,
    },
    Context {
        name: String,
        content: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        file_path: Option<PathBuf>,
    },
    ImageAttachment {
        attachment: ImageAttachmentRef,
    },
    /// Legacy transport form. New clients should use the attachment upload/import methods.
    Image {
        url: String,
    },
    Skill {
        skill: SkillRef,
    },
    Instruction {
        reference: InstructionRef,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartResult {
    pub turn_id: TurnId,
    #[ts(type = "number")]
    pub sequence: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnSteerResult {
    pub turn_id: TurnId,
    #[ts(type = "number")]
    pub sequence: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnInterruptResult {
    #[ts(type = "number")]
    pub sequence: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnInteractionResolveResult {
    #[ts(type = "number")]
    pub sequence: u64,
}
