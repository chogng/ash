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
        /// Window-lifetime key inherited by this window's integrated terminals.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        window_key: Option<String>,
    },
    Attach {
        window_key: String,
    },
    Unregister {},
    List {},
    Connect {
        window_id: String,
    },
    Disconnect {},
    /// Open the same durable conversation in the desktop, without transferring an active Turn.
    OpenConversation {
        session_id: SessionId,
        thread_id: ThreadId,
    },
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
    ConversationOpened {},
    ConversationBusy {},
    ConversationUnavailable {},
    Registered {
        window: IdeWindow,
    },
    Windows {
        windows: Vec<IdeWindow>,
        selected: Option<IdeWindow>,
        /// The terminal's originating window, retained while context sharing is disabled.
        #[serde(default)]
        #[ts(optional = nullable)]
        preferred: Option<IdeOrigin>,
    },
    Connected {
        window: Option<IdeWindow>,
    },
    Context {
        window: Option<IdeWindow>,
        context: Option<IdeContext>,
    },
}

/// First-party terminal provenance is retained even when the originating window is unavailable.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum IdeOrigin {
    Available { window: IdeWindow },
    Unavailable {},
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
    /// Acknowledged only after the desktop has loaded this existing conversation.
    OpenConversation {
        session_id: SessionId,
        thread_id: ThreadId,
    },
    Context {
        roots: Vec<String>,
    },
    OpenFile {
        path: String,
        line: Option<u32>,
    },
    OpenReview {
        original: String,
        modified: String,
    },
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
