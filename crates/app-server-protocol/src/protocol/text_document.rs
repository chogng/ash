use crate::JsonSchema;
use crate::TS;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
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
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    #[schemars(length(min = 1, max = 128))]
    pub changes: Vec<TextDocumentChangeDto>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TextDocumentTurnOutcome {
    Completed,
    Failed,
    Interrupted,
}

/// Sent only to the document connection that owns this Turn, after its tools finish.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextDocumentTurnFinished {
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub outcome: TextDocumentTurnOutcome,
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
