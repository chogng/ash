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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub command: Option<CommandEvidence>,
}

/// Counts cover the scanned commands; samples are the newest references from distinct Sessions.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandEvidence {
    pub occurrences: u32,
    pub session_count: u32,
    pub samples: Vec<CommandSource>,
}

/// Immutable history coordinates, not an endorsement of the command or its targets.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandSource {
    pub session_id: String,
    pub thread_id: String,
    pub turn_id: String,
    #[ts(type = "number")]
    pub sequence: u64,
    #[ts(type = "number")]
    pub recorded_at_unix_ms: u64,
}

/// The host supplies bounded tool inputs; only extracted facts reach drafts or a model.
pub struct CommandRecord {
    pub source: CommandSource,
    pub tool: String,
    pub arguments_json: String,
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
    /// Latest bounded project observations. They never inherit user acceptance or target trust.
    #[serde(default)]
    pub observations: Vec<EnvironmentEntry>,
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
    pub history: HistoryScanOptions,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryScanOptions {
    pub sessions: u32,
    pub commands_per_session: u32,
    /// None selects by recency without excluding infrequently used projects by age.
    pub days: Option<u32>,
}

impl Default for HistoryScanOptions {
    fn default() -> Self {
        Self {
            sessions: 50,
            commands_per_session: 200,
            days: None,
        }
    }
}

impl HistoryScanOptions {
    pub fn validate(&self) -> Result<(), EnvironmentError> {
        if !(1..=200).contains(&self.sessions)
            || !(1..=2000).contains(&self.commands_per_session)
            || self.days.is_some_and(|days| !(1..=3650).contains(&days))
        {
            return Err(EnvironmentError::Invalid(
                "history scope is outside its supported range".into(),
            ));
        }
        Ok(())
    }
}

/// Coverage describes the bounded scan, not the completeness of the project's environment.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryCoverage {
    #[ts(type = "number")]
    pub sessions_available: u64,
    pub sessions_scanned: u32,
    #[ts(type = "number")]
    pub commands_available: u64,
    pub commands_scanned: u32,
    pub facts_available: u32,
    pub facts_included: u32,
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
    /// Atomically refresh factual observations of the selected profile revision. A concurrent
    /// user edit invalidates this scan so excluded sources cannot be restored by a late reader.
    /// An unprepared project (revision zero) remains inactive. Unchanged sources do not write.
    fn refresh(
        &self,
        project: &str,
        expected_revision: u64,
        observations: &[EnvironmentEntry],
    ) -> Result<EnvironmentProfile, EnvironmentError>;
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
