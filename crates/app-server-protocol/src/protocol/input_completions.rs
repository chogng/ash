use crate::JsonSchema;
use crate::TS;
use crate::protocol::search::FileGlobTarget;
use ash_protocol::SessionId;
use ash_protocol::SkillRef;
use ash_protocol::ThreadId;
use serde::Deserialize;
use serde::Serialize;

/// Host-owned input grammar, advertised independently of any editor implementation.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputCompletionsCapability {
    pub version: u32,
    pub trigger_characters: Vec<String>,
}

/// One transient query. Directories are existing grants, never authorization requests.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputCompletionsParams {
    #[schemars(length(min = 1, max = 128))]
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_id: Option<SessionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub thread_id: Option<ThreadId>,
    #[schemars(length(max = 32))]
    pub directories: Vec<FileGlobTarget>,
    #[schemars(length(max = 1048576))]
    pub text: String,
    /// UTF-16 code units; an offset inside a surrogate pair is invalid.
    pub offset: usize,
}

/// Data retained when a suggestion is accepted; no editor objects cross the boundary.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum InputCompletionValue {
    Command,
    Skill {
        skill: SkillRef,
    },
    Resource {
        /// Index into the directories of the originating request.
        directory: usize,
        path: String,
        is_directory: bool,
    },
}

/// A half-open replacement in the exact request text, measured in UTF-16 code units.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputCompletionItem {
    pub label: String,
    pub insert_text: String,
    pub start: usize,
    pub end: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detail: Option<String>,
    pub preselect: bool,
    pub value: InputCompletionValue,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputCompletionsResult {
    pub items: Vec<InputCompletionItem>,
}
