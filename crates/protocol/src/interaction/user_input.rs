//! User-authored Turn input, including text, attachments, and explicit Skill references.

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
        /// Optional HTTPS link shown with the saved attachment.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        source_url: Option<String>,
    },
    /// A same-host conversation to resolve when this input is admitted.
    ChatReference {
        name: String,
        session_id: crate::SessionId,
        thread_id: crate::ThreadId,
    },
    /// Narrows this Turn's tool surface without granting execution authority.
    ToolSelection {
        disabled: Vec<crate::ToolName>,
        /// Positive scope resolved by the product, independent of model loading.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        allowed: Option<Vec<crate::ToolName>>,
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

/// Whether product command syntax may be interpreted in an otherwise textual Turn input.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CommandInterpretation {
    #[default]
    Product,
    Literal,
}

impl CommandInterpretation {
    pub fn is_product(&self) -> bool {
        matches!(self, Self::Product)
    }
}
