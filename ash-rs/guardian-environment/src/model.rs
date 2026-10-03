use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    Fact,
    Target,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    ProjectFile,
    RecentCommand,
    ShellHistory,
    OtherRepository,
    Manual,
}

/// A source identifies the exact observation, never a permission to read its parent directory.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentSource {
    pub id: String,
    pub kind: SourceKind,
    pub label: String,
    pub revision: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentEntry {
    pub id: String,
    pub kind: EntryKind,
    pub title: String,
    pub content: String,
    pub source: EnvironmentSource,
    /// Approval accepts this description as background, not as authorization for an action.
    pub accepted: bool,
    pub current: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntryInput {
    pub id: String,
    pub kind: EntryKind,
    pub title: String,
    pub content: String,
    /// None creates a user-authored entry. Clients cannot supply source labels or revisions.
    #[ts(optional = nullable)]
    pub source_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentProfile {
    #[ts(type = "number")]
    pub revision: u64,
    pub entries: Vec<EnvironmentEntry>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentDraft {
    pub id: String,
    #[ts(type = "number")]
    pub base_revision: u64,
    pub entries: Vec<EnvironmentEntry>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanOptions {
    pub recent_commands: bool,
    pub shell_history: bool,
    pub other_repositories: bool,
    pub summarize_with_model: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum EnvironmentError {
    #[error("review environment revision changed")]
    Conflict,
    #[error("invalid review environment: {0}")]
    Invalid(String),
    #[error("review environment operation cancelled")]
    Cancelled,
    #[error("review environment storage: {0}")]
    Storage(String),
    #[error("review environment source unavailable: {0}")]
    Source(String),
}

/// Durable state belongs to the host's State implementation; the domain owns validation.
pub trait EnvironmentStore: Send + Sync {
    fn read(&self, project: &str) -> Result<EnvironmentProfile, EnvironmentError>;
    /// A committed command remains replayable after its draft expires or its sources change.
    fn receipt(
        &self,
        project: &str,
        command_id: &str,
        request_digest: &str,
    ) -> Result<Option<EnvironmentProfile>, EnvironmentError>;
    /// One atomic compare-and-write with an idempotent, payload-bound command receipt.
    fn save(
        &self,
        project: &str,
        command_id: &str,
        request_digest: &str,
        expected_revision: u64,
        profile: &EnvironmentProfile,
    ) -> Result<EnvironmentProfile, EnvironmentError>;
}
