use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextDocumentReadParams {
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum TextDocumentReadResult {
    Document { snapshot: String, text: String },
    NotFound,
    Failed { message: String },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum TextDocumentChangeDto {
    Create {
        path: String,
        text: String,
    },
    Update {
        snapshot: String,
        text: String,
    },
    Delete {
        snapshot: String,
    },
    Move {
        snapshot: String,
        target: String,
        text: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextDocumentApplyParams {
    #[schemars(length(min = 1, max = 128))]
    pub changes: Vec<TextDocumentChangeDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum TextDocumentApplyResult {
    Applied,
    Conflict,
    Cancelled,
    Failed { message: String },
    OutcomeUnknown { message: String },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextDocumentReleaseParams {
    #[schemars(length(max = 128))]
    pub snapshots: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextDocumentListParams {
    pub root: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextDocumentContentDto {
    /// Path relative to the requested root, using forward slashes. The root's
    /// filesystem identity belongs to the server, not the editor's URI spelling.
    pub relative_path: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum TextDocumentListResult {
    Documents {
        documents: Vec<TextDocumentContentDto>,
    },
    Failed {
        message: String,
    },
}
