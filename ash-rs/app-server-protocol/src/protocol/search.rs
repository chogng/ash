use crate::JsonSchema;
use crate::TS;
use crate::protocol::config::ConfigCommandResult;
use crate::protocol::environment::SessionDirSelector;
use ash_protocol::CommandId;
use serde::Deserialize;
use serde::Serialize;
use std::path::PathBuf;

/// Selects how the directory search query is interpreted by the backend.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ContentSearchPatternKind {
    Literal,
    Regex,
}

/// Selects the case-matching behavior used by one directory search.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ContentSearchCaseSensitivity {
    Smart,
    Sensitive,
    Insensitive,
}

/// Selects asynchronous indexed results or a current disk scan.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ContentSearchFreshness {
    Indexed,
    #[default]
    Current,
}

/// Starts one bounded, connection-owned directory content search.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchStartParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
    #[schemars(length(min = 1, max = 16384))]
    pub query: String,
    pub pattern_kind: ContentSearchPatternKind,
    /// Defaults to current disk contents when omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub freshness: Option<ContentSearchFreshness>,
    pub case_sensitivity: ContentSearchCaseSensitivity,
    #[schemars(length(max = 64))]
    pub include_patterns: Vec<String>,
    #[schemars(length(max = 64))]
    pub exclude_patterns: Vec<String>,
    #[schemars(range(min = 1, max = 5000))]
    pub max_results: usize,
}

/// Identity allocated for one running directory search.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchStartResult {
    pub search_id: String,
}

/// Reads a bounded result batch after an already observed match cursor.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchReadParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
    #[schemars(length(min = 1))]
    pub search_id: String,
    pub after_match: usize,
    #[schemars(range(min = 1, max = 200))]
    pub max_matches: usize,
}

/// UTF-16 range within one returned preview line.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchMatchRange {
    pub start: usize,
    pub end: usize,
}

/// One line containing one or more matches in a directory-relative file.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchMatch {
    pub path: PathBuf,
    pub line_number: usize,
    pub preview: String,
    pub ranges: Vec<ContentSearchMatchRange>,
}

/// Bounded progress snapshot for a running or completed directory search.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchReadResult {
    pub search_id: String,
    pub matches: Vec<ContentSearchMatch>,
    pub next_match: usize,
    pub completed: bool,
    pub limit_hit: bool,
    pub error: Option<String>,
    /// Actual execution mode, available after a successful search.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub freshness: Option<ContentSearchFreshness>,
}

/// Cancels and releases one connection-owned directory search.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchCancelParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
    #[schemars(length(min = 1))]
    pub search_id: String,
}

/// Current state of the shared directory grep index; readiness is not freshness.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GrepIndexStatusResult {
    pub enabled: bool,
    pub active: bool,
    pub indexing: bool,
    pub ready: bool,
    pub indexed_file_count: usize,
    pub watcher_active: bool,
}

/// Starts the durable “disable and delete” shared grep operation.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GrepIndexDisableAndDeleteParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
}

/// Result of an explicit local-index deletion request.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LocalIndexClearOutcomeDto {
    Cleared,
    AlreadyAbsent,
    InUse,
}

/// Confirms the configuration commit separately from deletion of rebuildable data.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GrepIndexDisableAndDeleteResult {
    pub config: ConfigCommandResult,
    pub deletion: LocalIndexClearOutcomeDto,
}
