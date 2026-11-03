use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

/// A fixed, profile-owned Markdown resource; callers cannot supply filesystem paths.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SpeechInstructionKind {
    Voice,
    Dictation,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpeechInstructionsReadParams {
    pub kind: SpeechInstructionKind,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpeechInstructionsDocument {
    pub text: String,
    pub revision: String,
    pub exists: bool,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpeechInstructionsWriteParams {
    pub kind: SpeechInstructionKind,
    pub text: String,
    pub expected_revision: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpeechInstructionsWriteResult {
    pub revision: String,
}
