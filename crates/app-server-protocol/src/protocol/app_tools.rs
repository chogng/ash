use crate::JsonSchema;
use crate::TS;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use serde::Deserialize;
use serde::Serialize;

/// The originating connection can execute the application operations for this window.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppToolsCapability {
    pub version: u32,
    pub agents: bool,
    pub desktop: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppHostRequestParams {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub operation: AppHostOperation,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AppHostOperation {
    OpenFile {
        path: String,
        line: Option<u32>,
    },
    OpenBrowser {
        url: String,
    },
    OpenTerminal {},
    OpenReview {
        original: String,
        modified: String,
    },
    Navigate {
        session_id: SessionId,
        thread_id: ThreadId,
    },
    ListSections {},
    CreateSection {
        name: String,
    },
    RenameSection {
        section_id: String,
        name: String,
    },
    DeleteSection {
        section_id: String,
    },
    MoveSession {
        session_id: SessionId,
        section_id: Option<String>,
    },
    ReorderSection {
        section_id: String,
        session_ids: Vec<SessionId>,
    },
    CheckUpdate {},
    Confetti {},
}

/// Host results are bounded JSON text; tools keep the semantic result in their own contract.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppHostResult {
    pub json: String,
}

#[cfg(test)]
#[path = "app_tools_tests.rs"]
mod tests;
