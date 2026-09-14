use crate::ImageAttachmentRef;
use crate::InstructionRef;
use crate::SkillRef;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::path::PathBuf;
use ts_rs::TS;

/// A provider-independent input supplied by the user for one turn.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UserInput {
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
    /// Legacy inline/remote image input. New clients should materialize an attachment first.
    Image {
        url: String,
    },
    LocalImage {
        path: String,
    },
    Skill {
        skill: SkillRef,
    },
    Instruction {
        reference: InstructionRef,
    },
    Mention {
        name: String,
        path: String,
    },
}
