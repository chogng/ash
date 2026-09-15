use ash_protocol::CommandId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::path::PathBuf;
use ts_rs::TS;

use crate::protocol::config::ConfigCommandResult;

/// Lifecycle state of the directory-side codebase projection.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CodebaseStateDto {
    Empty,
    Indexing,
    Ready,
    Stale,
    Failed,
}

/// Published counters for the current or most recent usable codebase generation.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseStatusResult {
    pub state: CodebaseStateDto,
    pub root_id: String,
    #[ts(type = "number")]
    pub generation: u64,
    pub indexed_file_count: usize,
    pub indexed_chunk_count: usize,
    pub indexed_source_bytes: usize,
    pub skipped_file_count: usize,
    pub truncated_file_count: usize,
    pub file_limit_hit: bool,
    pub source_bytes_limit_hit: bool,
}

/// Current state of the optional tgrep index used by Agent grep.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TgrepIndexStatusResult {
    pub enabled: bool,
    pub active: bool,
    pub indexing: bool,
    pub ready: bool,
    pub indexed_file_count: usize,
    pub watcher_active: bool,
}

/// Starts the durable “disable and delete” Agent grep operation.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TgrepDisableAndDeleteParams {
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
pub struct TgrepDisableAndDeleteResult {
    pub config: ConfigCommandResult,
    pub deletion: LocalIndexClearOutcomeDto,
}

/// Performs one bounded lookup against the active Codebase.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseSearchParams {
    #[schemars(length(min = 1, max = 8192))]
    pub query: String,
    #[schemars(range(min = 1, max = 100))]
    pub max_results: usize,
}

/// Exact UTF-8 byte and zero-based line coverage of one indexed chunk.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseChunkSpanDto {
    pub start_byte: usize,
    pub end_byte: usize,
    pub start_line: usize,
    pub end_line_exclusive: usize,
}

/// One revision-bound match from the active Codebase.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseSearchHitDto {
    pub path: PathBuf,
    pub language: String,
    pub source_revision: String,
    pub chunk_key: String,
    pub content_hash: String,
    pub span: CodebaseChunkSpanDto,
    pub content: String,
    pub score: f64,
}

/// Bounded codebase matches paired with the generation that served them.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseSearchResult {
    pub status: CodebaseStatusResult,
    pub hits: Vec<CodebaseSearchHitDto>,
}

/// Performs one bounded retrieval across every source enabled for the directory.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseRetrievalParams {
    #[schemars(length(min = 1, max = 8192))]
    pub query: String,
    #[schemars(range(min = 1, max = 100))]
    pub max_results: usize,
}

/// Non-fatal loss reported while preserving usable retrieval results.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CodebaseRetrievalDegradationDto {
    CodebaseIncomplete,
    CloudCodebaseUnavailable,
    CandidateVerificationFailed { discarded: usize },
    ContentBudgetExceeded { discarded: usize },
}

/// One deduplicated, current-source-verified retrieval hit.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseRetrievalHitDto {
    pub path: PathBuf,
    pub language: String,
    pub source_revision: String,
    pub content_hash: String,
    pub span: CodebaseChunkSpanDto,
    pub content: String,
    pub rrf_score: f64,
}

/// Fused code excerpts and explicit degradation facts paired with local index status.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseRetrievalResult {
    pub status: CodebaseStatusResult,
    pub hits: Vec<CodebaseRetrievalHitDto>,
    pub degradations: Vec<CodebaseRetrievalDegradationDto>,
}

/// User-visible codebase deployment choice.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CodebaseDeploymentModeDto {
    LocalOnly,
    Cloud,
}

/// Durable publication/deletion phase of the selected cloud deployment.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CloudCodebaseStateDto {
    LocalOnly,
    Granted,
    Syncing,
    Ready,
    Stale,
    Revoking,
    Failed,
}

/// directory-relative source selection covered by a preview or grant.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CloudCodebaseSelectionDto {
    EntireIndex,
    PathPrefixes { prefixes: Vec<PathBuf> },
}

/// Non-secret remote provider namespace chosen by the user.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct CloudCodebaseDestinationDto {
    pub provider: String,
    pub tenant: String,
    pub collection: String,
}

/// Root-bound cloud source-egress grant projected through the App Server.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct CloudCodebaseGrantDto {
    pub grant_id: String,
    pub codebase_id: String,
    pub destination: CloudCodebaseDestinationDto,
    pub selection: CloudCodebaseSelectionDto,
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub max_egress_bytes: u64,
}

/// Computes the current source-content egress shape without persisting consent or networking.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct CloudCodebasePreviewParams {
    pub selection: CloudCodebaseSelectionDto,
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub max_egress_bytes: u64,
}

/// Bounded local preview of the directory-produced chunks eligible for publication.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CloudCodebasePreviewResult {
    #[ts(type = "number")]
    pub local_generation: u64,
    pub file_count: usize,
    pub chunk_count: usize,
    pub upload_unit_count: usize,
    #[ts(type = "number")]
    pub egress_bytes: u64,
    pub within_limit: bool,
}

/// Persists one explicit cloud destination, selection, and byte ceiling.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct CloudCodebaseAuthorizeParams {
    pub grant: CloudCodebaseGrantDto,
}

/// Current cloud deployment and local/remote generation relationship.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CloudCodebaseStatusResult {
    pub deployment_mode: CodebaseDeploymentModeDto,
    pub state: CloudCodebaseStateDto,
    pub root_id: String,
    pub grant: Option<CloudCodebaseGrantDto>,
    #[ts(type = "number")]
    pub local_generation: u64,
    #[ts(type = "number | null")]
    pub synced_local_generation: Option<u64>,
    pub remote_generation: Option<String>,
}
