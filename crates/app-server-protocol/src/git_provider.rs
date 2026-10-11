//! Private product-provider wire contract. Window-facing Git RPC remains in `protocol::git`.

use crate::protocol::git::*;
use serde::Deserialize;
use serde::Serialize;
use std::path::PathBuf;

pub const GIT_PROVIDER_CHANNEL: &str = "git.repository";
pub const GIT_PROVIDER_ID: &str = "ash.git";
pub const GIT_PROVIDER_PAYLOAD_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitProviderPolicy {
    pub autofetch: GitProviderFetch,
    pub autofetch_period: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitProviderFetch {
    Off,
    Default,
    All,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GitProviderDir {
    pub id: Option<String>,
    pub path: PathBuf,
    pub can_mutate: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum GitProviderRequest {
    Bind {
        version: u16,
        directories: Vec<GitProviderDir>,
    },
    Reconcile,
    CommonDirectory {
        repository_id: Option<String>,
    },
    StartWatching {
        policy: GitProviderPolicy,
    },
    Configure {
        policy: GitProviderPolicy,
    },
    DrainEvents,
    Clone {
        url: String,
        parent: PathBuf,
    },
    Initialize {
        root: PathBuf,
        branch: String,
    },
    Repositories,
    Status {
        repository_id: Option<String>,
    },
    CheckIgnore {
        repository_id: Option<String>,
        paths: Vec<PathBuf>,
    },
    LocalBranches {
        repository_id: Option<String>,
    },
    Catalog {
        repository_id: Option<String>,
    },
    Command {
        repository_id: Option<String>,
        command: ash_git::GitCommand,
    },
    IndexDiff {
        repository_id: Option<String>,
        path: PathBuf,
        comparison: ash_git::GitChangeFileComparison,
    },
    IndexEdit {
        repository_id: Option<String>,
        request: ash_git::GitIndexEdit,
    },
    CreateBranch {
        repository_id: Option<String>,
        name: String,
    },
    DeleteBranch {
        repository_id: Option<String>,
        name: String,
    },
    MutableSource {
        repository_id: Option<String>,
    },
    ReadableSource {
        repository_id: Option<String>,
    },
    RecentCommits {
        repository_id: Option<String>,
    },
    Graph {
        repository_id: Option<String>,
        connection_id: u64,
        limit: std::num::NonZeroUsize,
        cursor: Option<String>,
    },
    TextDiff {
        repository_id: Option<String>,
    },
    CommitChanges {
        repository_id: Option<String>,
        object_id: String,
    },
    CompareChanges {
        repository_id: Option<String>,
        object_id: String,
        base_reference: String,
        mode: ash_git::GitComparisonMode,
    },
    CommitMessage {
        repository_id: Option<String>,
        object_id: String,
    },
    CommitDetails {
        repository_id: Option<String>,
        object_id: String,
    },
    CommitFile {
        repository_id: Option<String>,
        object_id: String,
        path: PathBuf,
        comparison_base: Option<String>,
    },
    ChangeFile {
        repository_id: Option<String>,
        path: PathBuf,
        comparison: GitChangeFileComparisonDto,
    },
    ConflictFile {
        repository_id: Option<String>,
        path: PathBuf,
    },
    CompleteConflict {
        repository_id: Option<String>,
        path: PathBuf,
        expected_stage_ids: [Option<String>; 3],
        expected_result_object_id: Option<String>,
        resolution: GitConflictResolutionDto,
    },
    SwitchBranch {
        repository_id: Option<String>,
        name: String,
    },
    Stage {
        repository_id: Option<String>,
        paths: Vec<PathBuf>,
    },
    Unstage {
        repository_id: Option<String>,
        paths: Vec<PathBuf>,
    },
    DiscardWorktree {
        repository_id: Option<String>,
        paths: Vec<PathBuf>,
    },
    Commit {
        repository_id: Option<String>,
        request: ash_git::GitCommitRequest,
    },
    Fetch {
        repository_id: Option<String>,
        mode: GitFetchModeDto,
    },
    PullFastForward {
        repository_id: Option<String>,
    },
    Push {
        repository_id: Option<String>,
    },
    CloseConnection {
        connection_id: u64,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "result",
    content = "value",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum GitProviderResponse {
    Repositories(GitRepositoriesResult),
    Status(GitStatusResult),
    Paths(Vec<PathBuf>),
    Branches(Vec<GitBranchDto>),
    Catalog(ash_git::GitCatalog),
    Command(
        (
            GitStatusResult,
            ash_git::GitCommandOutcome,
            Option<ash_git::GitIntegration>,
        ),
    ),
    IndexDiff {
        original: Option<String>,
        modified: Option<String>,
    },
    Path(PathBuf),
    History(Vec<GitCommitSummaryDto>),
    Graph(GitGraphResult),
    TextDiff(GitTextDiffResult),
    CommitChanges(GitCommitChangesResult),
    CompareChanges(GitCompareChangesResult),
    Text(String),
    CommitDetails(ash_git::GitCommitDetails),
    CommitFile(GitCommitFileResult),
    ChangeFile(GitChangeFileResult),
    ConflictFile(GitConflictFileResult),
    Commit {
        object_id: String,
        status: GitStatusResult,
    },
    Done,
    Events(Vec<GitProviderEvent>),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "event",
    content = "value",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum GitProviderEvent {
    Resynchronize,
    RepositoriesChanged,
    StatusChanged(GitStatusResult),
    IgnoreChanged(GitIgnoreChanged),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitProviderError {
    Cancelled,
    Boundary,
    InvalidGraphCursor,
    RepositoryNotFound,
    BranchNotFound,
    CommitChangeNotFound,
    ConflictChanged,
    IndexChanged,
    NotAWorkingTree,
    OperationFailed { detail: String },
    Unavailable,
    Runtime,
}
