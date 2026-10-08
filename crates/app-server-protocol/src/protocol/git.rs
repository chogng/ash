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

/// Bounded paths relative to one authorized repository; directories do not expand recursively.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckIgnoreParams {
    #[schemars(length(min = 1, max = 128))]
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
    #[schemars(length(min = 1, max = 5000))]
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckIgnoreResult {
    pub ignored_paths: Vec<String>,
}

/// Cancels an ignore query owned by the requesting connection, including queued work.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCheckIgnoreCancelParams {
    #[schemars(length(min = 1, max = 128))]
    pub operation_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitCheckIgnoreCancelStatusDto {
    Requested,
    AlreadyRequested,
    Completed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckIgnoreCancelResult {
    pub status: GitCheckIgnoreCancelStatusDto,
}

/// Repository-relative paths whose ignore classification may have changed.
/// An empty path list invalidates the entire repository; directory paths include descendants.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitIgnoreChanged {
    pub repository_id: String,
    pub paths: Vec<String>,
}

/// Repository URL and host-selected parent directory for a desktop clone.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCloneParams {
    #[schemars(length(min = 1, max = 4096))]
    pub url: String,
    pub parent_path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCloneResult {
    pub repository_path: String,
}

/// Remote selection for a Git fetch operation.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitFetchModeDto {
    Default,
    #[default]
    All,
    Remote(#[schemars(length(min = 1, max = 4096))] String),
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
    Tag,
}

/// A branch or tag ref in a repository graph.
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

/// Compares the selected commit with a user-selected ref or their common ancestor.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCompareChangesParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
    #[schemars(length(min = 40, max = 64))]
    pub object_id: String,
    #[schemars(length(min = 1, max = 1024))]
    pub base_reference: String,
    pub mode: GitComparisonModeDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitComparisonModeDto {
    Direct,
    MergeBase,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitMessageResult {
    pub message: String,
}

/// Details for a history hover; totals compare a merge with its first parent.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetailsResult {
    pub author_name: String,
    pub author_email: String,
    #[ts(type = "number")]
    pub timestamp_seconds: i64,
    pub message: String,
    pub statistics: GitCommitStatisticsDto,
}

/// Includes binary paths in files, with line counts only for text paths.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitStatisticsDto {
    pub files: usize,
    #[ts(type = "number")]
    pub additions: u64,
    #[ts(type = "number")]
    pub deletions: u64,
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

/// The exact immutable base of an explicit comparison, including a resolved common ancestor.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCompareChangesResult {
    pub base_object_id: String,
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
    /// Exact base returned by compareChanges; omission compares with the commit's first parent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[schemars(length(min = 40, max = 64))]
    pub parent_object_id: Option<String>,
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

/// Identifies a conflicted path in the selected repository.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GitConflictFileParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
    #[schemars(length(min = 1, max = 32768))]
    pub path: String,
}

/// Exact unmerged index stages and the current working file.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GitConflictFileResult {
    pub stage_ids: [Option<String>; 3],
    pub result_object_id: Option<String>,
    pub base: GitCommitFileContentDto,
    pub current: GitCommitFileContentDto,
    pub incoming: GitCommitFileContentDto,
    pub result: GitCommitFileContentDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(tag = "kind", rename_all = "camelCase")]
pub enum GitConflictResolutionDto {
    Edited {
        #[schemars(length(max = 2097152))]
        text: String,
    },
    Current,
    Incoming,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GitCompleteConflictParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
    #[schemars(length(min = 1, max = 32768))]
    pub path: String,
    pub expected_stage_ids: [Option<String>; 3],
    pub expected_result_object_id: Option<String>,
    pub resolution: GitConflictResolutionDto,
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

/// Deletes one merged local branch that is not checked out in any worktree.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchDeleteParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
    #[schemars(length(min = 1, max = 1024))]
    pub name: String,
}

/// Creates an independent detached checkout at HEAD without starting a Thread.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeCreateParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
    #[schemars(length(min = 1, max = 64))]
    pub name: String,
}

/// Removes one linked checkout, or its owning Session and managed worktrees.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeDeleteParams {
    pub command_id: ash_protocol::CommandId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
    #[schemars(length(min = 1, max = 32768))]
    pub checkout_root: String,
    pub mode: GitWorktreeDeleteMode,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitWorktreeDeleteMode {
    /// Remove a clean linked checkout with no Session owner.
    Unbound,
    /// Delete the owning Session and discard every managed directory it owns.
    SessionAndWorktrees,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeCreateResult {
    pub path: String,
}

/// One checkout in the selected repository. `path` preserves the caller's relative directory.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeDto {
    pub checkout_root: String,
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub current: bool,
    pub state: GitWorktreeStateDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitWorktreeStateDto {
    Ready,
    ThreadOwned,
    Locked,
    Prunable,
    Invalid,
    MissingDirectory,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeListResult {
    pub worktrees: Vec<GitWorktreeDto>,
}

/// Revalidates one listed checkout before opening it as a workspace.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeResolveParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
    pub checkout_root: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeResolveResult {
    pub path: String,
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitCommitScopeDto {
    Staged,
    Tracked,
    IncludeUntracked,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitCommitModeDto {
    Create,
    Amend,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitCommitSignoffDto {
    None,
    Add,
}

/// Omitted options retain index-only creation without sign-off.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
    #[schemars(length(min = 1, max = 65536))]
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scope: Option<GitCommitScopeDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mode: Option<GitCommitModeDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub signoff: Option<GitCommitSignoffDto>,
    /// Captured Amend target, checked before staging; upstream counts are ignored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub expected_head: Option<GitHeadDto>,
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

/// Git metadata is the authority for an unfinished integration, including after reconnect.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitIntegrationDto {
    Merge,
    Rebase,
    CherryPick,
}

/// Closed repository intents; this API never accepts executable names or Git argument arrays.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(tag = "kind", rename_all = "camelCase")]
pub enum GitCommandDto {
    FetchAndCheckout {
        remote: String,
        #[ts(rename = "remoteIdentity")]
        remote_identity: String,
        reference: String,
        #[ts(rename = "objectId")]
        object_id: String,
        name: String,
    },
    PushBranch {
        remote: String,
        #[ts(rename = "remoteIdentity")]
        remote_identity: String,
        name: String,
        branch: String,
        #[ts(rename = "expectedHead")]
        expected_head: String,
    },
    CreateBranchAt {
        name: String,
        #[ts(rename = "objectId")]
        object_id: String,
    },
    CheckoutDetached {
        #[ts(rename = "objectId")]
        object_id: String,
    },
    CheckoutRemoteBranch {
        name: String,
        reference: String,
    },
    RenameBranch {
        name: String,
        #[ts(rename = "newName")]
        new_name: String,
    },
    DeleteRemoteBranch {
        remote: String,
        name: String,
    },
    Merge {
        reference: String,
    },
    Rebase {
        reference: String,
    },
    CherryPick {
        reference: String,
        /// One-based parent defining a merge commit's changes.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        #[schemars(range(min = 1))]
        mainline: Option<u32>,
    },
    Continue {
        operation: GitIntegrationDto,
    },
    Abort {
        operation: GitIntegrationDto,
    },
    Stash {
        message: String,
        mode: GitStashModeDto,
    },
    ApplyStash {
        #[ts(rename = "objectId")]
        object_id: String,
    },
    PopStash {
        #[ts(rename = "objectId")]
        object_id: String,
    },
    DropStash {
        #[ts(rename = "objectId")]
        object_id: String,
    },
    CreateTag {
        name: String,
        reference: String,
    },
    DeleteTag {
        name: String,
    },
    AddRemote {
        name: String,
        url: String,
    },
    RemoveRemote {
        name: String,
    },
    Amend {
        message: String,
    },
    UndoCommit {
        #[ts(rename = "expectedHead")]
        expected_head: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitStashModeDto {
    Tracked,
    IncludeUntracked,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommandParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
    pub command: GitCommandDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitCommandOutcomeDto {
    Completed,
    Conflicted,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommandResult {
    pub status: GitStatusResult,
    pub outcome: GitCommandOutcomeDto,
    pub operation: Option<GitIntegrationDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitNamedRefDto {
    pub name: String,
    pub object_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitStashDto {
    pub object_id: String,
    pub subject: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCatalogResult {
    pub tags: Vec<GitNamedRefDto>,
    pub stashes: Vec<GitStashDto>,
    pub remotes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub upstream_remote: Option<String>,
    pub operation: Option<GitIntegrationDto>,
}

/// Initialization targets an already authorized workspace directory, not an arbitrary host path.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitInitParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[schemars(length(min = 1, max = 1024))]
    pub initial_branch: String,
}

/// Selection is interpreted against the exact reviewed comparison; no client-crafted patch runs.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GitIndexSelectionDto {
    Hunk {
        index: usize,
    },
    Lines {
        #[schemars(range(min = 1))]
        start: usize,
        #[schemars(range(min = 1))]
        end: usize,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitIndexEditParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
    pub path: String,
    pub comparison: GitChangeFileComparisonDto,
    #[schemars(length(max = 2097152))]
    pub expected_original: Option<String>,
    #[schemars(length(max = 2097152))]
    pub expected_modified: Option<String>,
    pub selection: GitIndexSelectionDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitIndexHunkDto {
    pub index: usize,
    pub old_start: usize,
    pub old_count: usize,
    pub new_start: usize,
    pub new_count: usize,
    pub preview: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitIndexDiffResult {
    pub original: Option<String>,
    pub modified: Option<String>,
    pub hunks: Vec<GitIndexHunkDto>,
}
