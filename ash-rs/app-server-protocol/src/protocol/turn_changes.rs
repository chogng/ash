use crate::JsonSchema;
use crate::TS;
use crate::protocol::common::{CommandId, SessionId, ThreadId, TurnId};
use serde::{Deserialize, Serialize};

/// Stable identity of one Turn/repository change set.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[serde(transparent)]
pub struct ChangeSetId(pub String);

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TurnChangeCaptureStateDto {
    Open,
    Sealed,
    Incomplete,
    Discarded,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TurnChangeMessageStateDto {
    Unconfigured,
    Queued,
    Generating,
    Ready,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TurnChangeCommitStateDto {
    Idle,
    Queued,
    Committing,
    Committed,
    Conflict,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TurnChangeTerminalStateDto {
    Completed,
    Failed,
    Interrupted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TurnChangeFileKindDto {
    Added,
    Modified,
    Deleted,
    Renamed,
    TypeChanged,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangeFileDto {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub previous_path: Option<String>,
    pub kind: TurnChangeFileKindDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub before_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub after_mode: Option<String>,
    pub binary: bool,
    #[ts(type = "number")]
    pub additions: u64,
    #[ts(type = "number")]
    pub deletions: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangeFileStatisticsDto {
    #[ts(type = "number")]
    pub files: u64,
    #[ts(type = "number")]
    pub additions: u64,
    #[ts(type = "number")]
    pub deletions: u64,
}

/// Public binding for a Thread directory. Managed filesystem paths stay private to App Server.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDirBinding {
    pub managed_worktree_id: String,
    pub source_dir_id: String,
    pub repositories: Vec<ThreadWorktreeRepositoryBindingDto>,
    pub baseline_summary: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThreadWorktreeRepositoryBindingDto {
    pub repository_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub target_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub baseline_object_id: Option<String>,
}

/// Small record used by Session Inspector lists and notifications.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangeSetSummary {
    pub change_set_id: ChangeSetId,
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub repository_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub target_branch: Option<String>,
    pub statistics: TurnChangeFileStatisticsDto,
    pub capture_state: TurnChangeCaptureStateDto,
    pub message_state: TurnChangeMessageStateDto,
    pub commit_state: TurnChangeCommitStateDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub terminal_state: Option<TurnChangeTerminalStateDto>,
    pub dependencies: Vec<ChangeSetId>,
    pub external_dependency_paths: Vec<String>,
    pub warnings: Vec<String>,
    pub conflict_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub commit_id: Option<String>,
    #[ts(type = "number")]
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangesListParams {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangesListResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir: Option<ThreadDirBinding>,
    pub change_sets: Vec<TurnChangeSetSummary>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangesReadParams {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub change_set_id: ChangeSetId,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangesReadResult {
    pub summary: TurnChangeSetSummary,
    pub files: Vec<TurnChangeFileDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub generated_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub draft_message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangesReadFileParams {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub change_set_id: ChangeSetId,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangesReadFileResult {
    pub path: String,
    pub binary: bool,
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub after: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangesMutationParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub change_set_id: ChangeSetId,
    #[ts(type = "number")]
    pub expected_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangesUpdateDraftParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub change_set_id: ChangeSetId,
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangesCommitParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub change_set_ids: Vec<ChangeSetId>,
    #[ts(type = "number")]
    pub expected_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangesDiscardThreadParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub confirmed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangesMutationResult {
    pub change_sets: Vec<TurnChangeSetSummary>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangesChanged {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub change_sets: Vec<TurnChangeSetSummary>,
}
