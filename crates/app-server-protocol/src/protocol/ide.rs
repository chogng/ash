//! Connection-scoped discovery and explicit attachment to an Ash editor window.
use crate::JsonSchema;
use crate::TS;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdeWindow {
    pub id: String,
    pub title: String,
    pub roots: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum IdeRequest {
    Register {
        title: String,
        roots: Vec<String>,
    },
    Unregister {},
    List {},
    Connect {
        window_id: String,
    },
    Disconnect {},
    Context {
        session_id: SessionId,
        thread_id: ThreadId,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum IdeResult {
    Registered {
        window: IdeWindow,
    },
    Windows {
        windows: Vec<IdeWindow>,
        selected: Option<IdeWindow>,
    },
    Connected {
        window: Option<IdeWindow>,
    },
    Context {
        window: Option<IdeWindow>,
        context: Option<IdeContext>,
    },
}

/// A bounded, versioned snapshot. It supplies context, never editor write authority.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdeContext {
    pub active_file: Option<IdeActiveFile>,
    pub open_tabs: Vec<String>,
    pub dirty_files: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdeActiveFile {
    pub path: String,
    pub version: u32,
    pub selections: Vec<IdeSelection>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdeSelection {
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub text: String,
    /// Only a prefix of the selected range fits in the context budget.
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum IdeHostRequest {
    Context { roots: Vec<String> },
    OpenFile { path: String, line: Option<u32> },
    OpenReview { original: String, modified: String },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum IdeHostResult {
    Context { context: IdeContext },
    Opened {},
}
