use crate::JsonSchema;
use crate::TS;
use ash_protocol::StreamInstanceId;
use serde::Deserialize;
use serde::Serialize;

/// Selects one repository discovered inside the active directory.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
}

/// Remote selection for a Git fetch operation.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitFetchModeDto {
    Default,
    #[default]
    All,
}

/// Selects a repository and the remotes to fetch.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitFetchParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mode: Option<GitFetchModeDto>,
}

/// Stable, directory-relative identity for one discovered Git repository projection.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryDto {
    pub id: String,
    pub label: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoriesResult {
    pub repositories: Vec<GitRepositoryDto>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitChangeStatusDto {
    Unmodified,
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Unmerged,
    Untracked,
    Ignored,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitUpstreamDto {
    pub name: String,
    pub ahead: usize,
    pub behind: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum GitHeadDto {
    Branch {
        name: String,
        #[serde(rename = "objectId")]
        #[ts(rename = "objectId")]
        object_id: String,
        upstream: Option<GitUpstreamDto>,
    },
    Detached {
        #[serde(rename = "objectId")]
        #[ts(rename = "objectId")]
        object_id: String,
    },
    Unborn {
        name: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitSubmoduleStateDto {
    pub is_submodule: bool,
    pub commit_changed: bool,
    pub tracked_changes: bool,
    pub untracked_changes: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryChangeDto {
    pub path: String,
    pub original_path: Option<String>,
    pub index_status: GitChangeStatusDto,
    pub worktree_status: GitChangeStatusDto,
    pub conflicted: bool,
    pub submodule: GitSubmoduleStateDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub repository_id: String,
    pub stream_instance_id: StreamInstanceId,
    #[ts(type = "number")]
    pub revision: u64,
    pub path: String,
    pub head: GitHeadDto,
    pub changes: Vec<GitRepositoryChangeDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusChanged {
    pub status: GitStatusResult,
}

/// One local branch returned by the directory Git runtime.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchDto {
    pub name: String,
    pub object_id: String,
    pub current: bool,
    pub upstream: Option<String>,
    /// Whether another worktree has checked out this branch. Older servers omit this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub checked_out_elsewhere: Option<bool>,
}

impl GitBranchDto {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub const fn is_current(&self) -> bool {
        self.current
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchListResult {
    pub branches: Vec<GitBranchDto>,
}

/// One commit in the bounded history projection used by repository graph views.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitSummaryDto {
    pub object_id: String,
    pub parent_object_ids: Vec<String>,
    #[ts(type = "number")]
    pub timestamp_seconds: i64,
    pub subject: String,
}

/// Bounded recent commit history for the active directory repository.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryResult {
    pub commits: Vec<GitCommitSummaryDto>,
}

/// Provider classification for a configured repository remote.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum GitRemoteProviderDto {
    Github,
    Gitlab,
    Bitbucket,
    Other,
}

/// Credential-free repository identity parsed from a configured Git remote.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GitRepositoryIdentityDto {
    pub provider: GitRemoteProviderDto,
    pub host: String,
    pub owner: String,
    pub repository: String,
}

/// One configured Git remote, with raw URLs intentionally omitted from the wire contract.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GitRemoteDto {
    pub name: String,
    pub identity: Option<GitRepositoryIdentityDto>,
}

/// Ref kinds included in a repository graph snapshot.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum GitReferenceKindDto {
    LocalBranch,
    RemoteBranch,
}

/// A local or fetched remote-tracking branch ref.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GitReferenceDto {
    pub name: String,
    pub object_id: String,
    pub kind: GitReferenceKindDto,
    pub remote_name: Option<String>,
    pub current: bool,
}

/// Starts or continues one bounded traversal of the active directory repository graph.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GitGraphParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
    #[schemars(range(min = 1, max = 1000))]
    pub limit: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cursor: Option<String>,
}

/// One bounded commit graph page and its continuation cursor.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GitGraphResult {
    pub commits: Vec<GitCommitSummaryDto>,
    pub references: Vec<GitReferenceDto>,
    pub remotes: Vec<GitRemoteDto>,
    pub has_more: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next_cursor: Option<String>,
}

/// Identifies one commit whose changed paths should be expanded in repository history.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GitCommitChangesParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
    #[schemars(length(min = 40, max = 64))]
    pub object_id: String,
}

/// One repository-relative path changed by a commit relative to its first parent.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GitCommitChangeDto {
    pub path: String,
    pub original_path: Option<String>,
    pub status: GitChangeStatusDto,
}

/// The changed paths and comparison parent for one commit history item.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GitCommitChangesResult {
    pub parent_object_id: Option<String>,
    pub changes: Vec<GitCommitChangeDto>,
}

/// Identifies one changed file to read at a commit and its comparison parent.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GitCommitFileParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
    #[schemars(length(min = 40, max = 64))]
    pub object_id: String,
    #[schemars(length(min = 1, max = 32768))]
    pub path: String,
}

/// Bounded editor content for one side of a committed file comparison.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[ts(rename_all = "camelCase")]
pub enum GitCommitFileContentDto {
    Missing,
    Binary,
    Text { text: String },
}

/// Before/after editor content for one committed file.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GitCommitFileResult {
    pub original: GitCommitFileContentDto,
    pub modified: GitCommitFileContentDto,
}

/// Selects the two repository states represented by a current SCM resource group.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum GitChangeFileComparisonDto {
    Staged,
    Unstaged,
}

/// Identifies one current repository change and the SCM group that owns it.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GitChangeFileParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
    #[schemars(length(min = 1, max = 32768))]
    pub path: String,
    pub comparison: GitChangeFileComparisonDto,
}

/// Before/after editor content for one current staged or unstaged change.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GitChangeFileResult {
    pub original: GitCommitFileContentDto,
    pub modified: GitCommitFileContentDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchSwitchParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
    #[schemars(length(min = 1, max = 1024))]
    pub name: String,
}

/// Creates a local branch at the selected checkout's HEAD without switching it or starting a task.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchCreateParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
    #[schemars(length(min = 1, max = 1024))]
    pub name: String,
}

/// One bounded UTF-8 text change from `HEAD` to the directory working tree.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitTextDiffDto {
    pub path: String,
    pub original: String,
    pub modified: String,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffStatisticsDto {
    pub files: usize,
    pub additions: usize,
    pub deletions: usize,
}

/// One authoritative status snapshot plus its bounded directory text-diff projection.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitTextDiffResult {
    pub status: GitStatusResult,
    pub diffs: Vec<GitTextDiffDto>,
    pub statistics: GitDiffStatisticsDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitPathsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
    #[schemars(length(min = 1, max = 5000))]
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
    #[schemars(length(min = 1, max = 65536))]
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationResult {
    pub status: GitStatusResult,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
    pub object_id: String,
    pub status: GitStatusResult,
}
