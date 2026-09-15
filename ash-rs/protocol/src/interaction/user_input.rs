use crate::AudioAttachmentRef;
use crate::ImageAttachmentRef;
use crate::SkillRef;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// A provider-independent input supplied by the user for one turn.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UserInput {
    AudioAttachment {
        attachment: AudioAttachmentRef,
    },
    /// Inline audio is validated and stored before turn admission.
    Audio {
        url: String,
    },
    Text {
        text: String,
    },
    Context {
        name: String,
        content: String,
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
    Mention {
        name: String,
        path: String,
    },
}
