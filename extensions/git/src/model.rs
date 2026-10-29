use crate::paths::RepoPath;
use crate::paths::ResourceUri;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

/// Extension-owned view model. Transport response normalization stays in `api`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: RepoPath,
    pub original_path: Option<RepoPath>,
    pub index_status: String,
    pub worktree_status: String,
    pub conflicted: bool,
    pub submodule: Submodule,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Submodule {
    pub is_submodule: bool,
    pub commit_changed: bool,
    pub tracked_changes: bool,
    pub untracked_changes: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum Head {
    Branch {
        name: String,
        #[serde(rename = "objectId")]
        object_id: String,
        upstream: Option<Upstream>,
    },
    Detached {
        #[serde(rename = "objectId")]
        object_id: String,
    },
    Unborn {
        name: String,
    },
}
impl Head {
    pub fn name(&self) -> Option<&str> {
        match self {
            Self::Branch { name, .. } | Self::Unborn { name } => Some(name),
            _ => None,
        }
    }
    pub fn object_id(&self) -> Option<&str> {
        match self {
            Self::Branch { object_id, .. } | Self::Detached { object_id } => Some(object_id),
            _ => None,
        }
    }
    pub fn upstream(&self) -> Option<&Upstream> {
        if let Self::Branch { upstream, .. } = self {
            upstream.as_ref()
        } else {
            None
        }
    }
    pub fn same_target(&self, other: &Self) -> bool {
        self.name() == other.name() && self.object_id() == other.object_id()
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Upstream {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    pub ahead: usize,
    pub behind: usize,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub repository_id: String,
    pub stream_instance_id: String,
    pub revision: u64,
    pub history_revision: u64,
    pub path: String,
    pub head: Head,
    pub changes: Vec<Change>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryDescriptor {
    pub id: String,
    pub label: String,
    pub path: String,
    pub dir_id: Option<String>,
    pub parent_path: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct WorkspaceFolder {
    pub id: String,
    pub name: String,
    pub uri: ResourceUri,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryFolder {
    pub dir_id: String,
    pub max_depth: i64,
    pub ignored_folders: Vec<String>,
    pub scan_repositories: Vec<String>,
    pub detect_submodules: bool,
    pub submodule_limit: u64,
    pub detect_worktrees: bool,
    pub worktree_limit: u64,
}

#[derive(Deserialize, Serialize)]
pub struct Discovery {
    pub repositories: Vec<RepositoryDescriptor>,
    pub statuses: Option<Vec<Status>>,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Installation {
    Missing,
    Unsupported {
        version: String,
        minimum_version: String,
    },
    Available {
        version: String,
    },
}
#[derive(Clone, Default)]
pub struct Configuration(pub Value);
impl Configuration {
    pub fn value(&self, key: &str) -> &Value {
        if let Some(value) = self.0.get(key) {
            return value;
        }
        key.split('.')
            .try_fold(&self.0, |value, segment| value.get(segment))
            .unwrap_or(&Value::Null)
    }
    pub fn boolean(&self, key: &str, default: bool) -> bool {
        self.value(key).as_bool().unwrap_or(default)
    }
    pub fn number(&self, key: &str, default: u64) -> u64 {
        self.value(key).as_u64().unwrap_or(default)
    }
    pub fn text<'a>(&'a self, key: &str, default: &'a str) -> &'a str {
        self.value(key).as_str().unwrap_or(default)
    }
    pub fn strings(&self, key: &str) -> Vec<String> {
        self.value(key)
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    }
}
#[derive(Clone)]
pub struct Repository {
    pub descriptor: RepositoryDescriptor,
    pub root_uri: ResourceUri,
    pub configuration: Configuration,
    pub status: Option<Status>,
    pub catalog: Option<Catalog>,
    pub draft: String,
    pub input_revision: u64,
    pub operation: Option<RepositoryOperation>,
    pub error: String,
    pub notice: String,
    /// The message editor's intent stays attached to the HEAD at which it was opened.
    pub commit_editor_head: Option<Head>,
    pub blame: Option<Blame>,
    pub pending_paths: Option<PendingPaths>,
    pub retired_streams: BTreeSet<String>,
}

/// Backend-owned remote facts retained with the extension's repository snapshot.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub remotes: Vec<String>,
    pub tags: Vec<NamedRef>,
    pub stashes: Vec<Stash>,
    pub upstream_remote: Option<String>,
    pub operation: Option<Integration>,
    #[serde(default)]
    pub upstream_read_only: bool,
}
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum RepositoryOperation {
    Preparing,
    Synchronize,
    Other,
}
impl Repository {
    pub fn is_busy(&self) -> bool {
        self.operation.is_some()
    }
}
#[derive(Clone, PartialEq)]
pub struct Blame {
    pub label: String,
    pub details: String,
}

#[derive(Default)]
pub struct State {
    pub repositories: BTreeMap<String, Repository>,
    pub active: Option<String>,
    pub selection_revision: u64,
    pub folders: Vec<WorkspaceFolder>,
    pub sequence: u64,
    pub revision: u64,
    pub configuration: Configuration,
    pub active_line_signature: String,
    pub installation_signature: Option<Value>,
    pub installation_available: bool,
    pub discovery_signature: Option<Value>,
    pub parent_prompts: BTreeSet<String>,
    pub discovery_result: Vec<RepositoryDescriptor>,
}

#[derive(Clone)]
pub struct PendingPaths {
    pub operation: PathOperation,
    pub paths: BTreeSet<RepoPath>,
}
#[derive(Clone, Copy)]
pub enum PathOperation {
    Stage,
    Unstage,
}

#[derive(Clone, Copy, PartialEq)]
pub enum PathMutation {
    Stage,
    Unstage,
    Discard,
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Comparison {
    Staged,
    Unstaged,
}

impl std::fmt::Display for Comparison {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Staged => "staged",
            Self::Unstaged => "unstaged",
        })
    }
}

#[derive(Deserialize, Serialize)]
pub struct Mutation {
    pub status: Status,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexHunk {
    pub index: usize,
    pub old_start: usize,
    pub old_count: usize,
    pub new_start: usize,
    pub new_count: usize,
    pub preview: String,
}

#[derive(Deserialize, Serialize)]
pub struct IndexDiff {
    pub original: Option<String>,
    pub modified: Option<String>,
    pub hunks: Vec<IndexHunk>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum IndexSelection {
    Hunk { index: usize },
    Lines { start: usize, end: usize },
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileContent {
    Missing,
    Binary { data: Option<String> },
    Text { text: String },
}

impl FileContent {
    pub fn text(&self) -> Option<&str> {
        match self {
            Self::Text { text } => Some(text),
            Self::Missing | Self::Binary { .. } => None,
        }
    }
    pub fn is_binary(&self) -> bool {
        matches!(self, Self::Binary { .. })
    }
}

#[derive(Deserialize, Serialize)]
pub struct FileComparison {
    pub original: FileContent,
    pub modified: FileContent,
}

#[derive(Deserialize, Serialize)]
pub struct RemovalFile {
    pub path: RepoPath,
    pub revision: String,
}

#[derive(Deserialize, Serialize)]
pub struct RemovalEntry {
    pub file: RemovalFile,
    pub committed: bool,
    pub changed: bool,
}

#[derive(Deserialize, Serialize)]
pub struct RemovalReview {
    pub head: Head,
    pub entries: Vec<RemovalEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RemovalMode {
    Trash,
    Permanent,
}

/// Closed business intents. Only the transport adapter chooses backend method names.
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RepositoryCommand {
    FetchAndCheckout {
        remote: String,
        remote_identity: String,
        reference: String,
        object_id: String,
        name: String,
    },
    PublishBranch {
        remote: String,
        name: String,
        branch: String,
        expected_head: String,
    },
    PushBranch {
        remote: String,
        remote_identity: String,
        name: String,
        branch: String,
        expected_head: String,
    },
    CreateBranchAt {
        name: String,
        object_id: String,
    },
    CheckoutDetached {
        object_id: String,
    },
    CheckoutRemoteBranch {
        name: String,
        reference: String,
    },
    RenameBranch {
        name: String,
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
        mainline: Option<u32>,
    },
    Continue {
        operation: Integration,
    },
    Abort {
        operation: Integration,
    },
    Stash {
        message: String,
        mode: StashMode,
    },
    ApplyStash {
        object_id: String,
    },
    PopStash {
        object_id: String,
    },
    DropStash {
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
        expected_head: String,
    },
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Integration {
    Merge,
    Rebase,
    CherryPick,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StashMode {
    Tracked,
    IncludeUntracked,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandOutcome {
    Completed,
    Conflicted,
}

#[derive(Deserialize, Serialize)]
pub struct ExecutedCommand {
    pub status: Status,
    pub outcome: CommandOutcome,
    pub operation: Option<Integration>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportOptions {
    pub prune: bool,
    pub pull_tags: bool,
    pub replace_tags: bool,
    pub auto_stash: bool,
    pub follow_tags: bool,
    pub push_mode: PushMode,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PushMode {
    Normal,
    Force,
    Lease,
    LeaseIfIncludes,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FetchMode {
    Default,
    All,
    Remote(String),
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PullMode {
    Configured,
    Rebase,
    Sync,
}

pub enum TransportOperation<'a> {
    Fetch(FetchMode),
    Pull {
        mode: PullMode,
        expected_head: Option<&'a Head>,
    },
    Push {
        expected_head: &'a Head,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TransportOutcome {
    Completed,
    TagConflict { tags: Vec<String> },
}

#[derive(Deserialize, Serialize)]
pub struct TransportResult {
    pub status: Status,
    pub outcome: TransportOutcome,
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommitScope {
    Staged,
    Tracked,
    IncludeUntracked,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommitMode {
    Create,
    Amend,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Signoff {
    None,
    Add,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Signing {
    Configured,
    Required,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EmptyCommit {
    Reject,
    Allow,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommitHooks {
    Skip,
    Run,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommitIdentity {
    Configured,
    Inferred,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitIntent {
    pub message: String,
    pub scope: CommitScope,
    pub mode: CommitMode,
    pub signoff: Signoff,
    pub signing: Signing,
    pub empty: EmptyCommit,
    pub hooks: CommitHooks,
    pub identity: CommitIdentity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_head: Option<Head>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Committed {
    pub object_id: String,
    pub status: Status,
}

#[derive(Serialize)]
pub struct EditorEvidence {
    pub path: RepoPath,
    pub text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attribution {
    pub present: bool,
    pub co_author: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NamedRef {
    pub name: String,
    pub object_id: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    pub object_id: String,
    pub subject: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub object_id: String,
    pub current: bool,
    pub upstream: Option<String>,
    pub checked_out_elsewhere: Option<bool>,
}
#[derive(Deserialize, Serialize)]
pub struct Branches {
    pub branches: Vec<Branch>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteIdentity {
    pub provider: String,
    pub host: String,
    pub owner: String,
    pub repository: String,
}
#[derive(Deserialize, Serialize)]
pub struct Remote {
    pub name: String,
    pub identity: Option<RemoteIdentity>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReferenceKind {
    LocalBranch,
    RemoteBranch,
    Tag,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub name: String,
    pub object_id: String,
    pub kind: ReferenceKind,
    pub remote_name: Option<String>,
    pub current: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub object_id: String,
    pub parent_object_ids: Vec<String>,
    pub timestamp_seconds: i64,
    pub subject: String,
}
#[derive(Serialize)]
pub struct GraphQuery {
    pub limit: usize,
    pub cursor: Option<String>,
    pub revisions: Option<Vec<String>>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPage {
    pub commits: Vec<CommitSummary>,
    pub references: Vec<Reference>,
    pub remotes: Vec<Remote>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRefs {
    pub status: Status,
    pub references: Vec<Reference>,
    pub remotes: Vec<Remote>,
    pub branches: Vec<Branch>,
    pub base_reference: Option<Reference>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitChange {
    pub path: RepoPath,
    pub original_path: Option<RepoPath>,
    pub status: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitChanges {
    pub parent_object_id: Option<String>,
    pub changes: Vec<CommitChange>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparedChanges {
    pub base_object_id: String,
    pub changes: Vec<CommitChange>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CompareMode {
    Direct,
    MergeBase,
}
#[derive(Deserialize, Serialize)]
pub struct CommitMessage {
    pub message: String,
}
#[derive(Deserialize, Serialize)]
pub struct CommitStatistics {
    pub files: usize,
    pub additions: u64,
    pub deletions: u64,
}
pub struct ChangesSummary {
    pub files: usize,
    pub additions: u64,
    pub deletions: u64,
    pub partial: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub author_name: String,
    pub author_email: String,
    pub timestamp_seconds: i64,
    pub message: String,
    pub statistics: CommitStatistics,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryItem {
    pub path: RepoPath,
    pub object_id: String,
    pub author_name: String,
    pub author_time: i64,
    pub commit_time: i64,
    pub subject: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistory {
    pub items: Vec<FileHistoryItem>,
    pub next_cursor: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub object_id: String,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub subject: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub stage_ids: [Option<String>; 3],
    pub result_object_id: Option<String>,
    pub base: FileContent,
    pub current: FileContent,
    pub incoming: FileContent,
    pub result: FileContent,
}
#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ConflictResolution {
    Edited { text: String },
    Current,
    Incoming,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveConflict {
    pub path: RepoPath,
    pub expected_stage_ids: [Option<String>; 3],
    pub expected_result_object_id: Option<String>,
    pub resolution: ConflictResolution,
}

#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AutoFetch {
    Off,
    Default,
    All,
}
#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedSettings {
    pub autofetch: AutoFetch,
    pub autofetch_period: u32,
    pub rebase_when_sync: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub revision: u64,
    pub git: SharedSettings,
    pub git_configured: bool,
}
#[derive(Deserialize, Serialize)]
pub struct SettingsUpdated {
    // The capability grant exposes only the saved revision, not the complete
    // application configuration response or its runtime generation.
    pub revision: u64,
}

/// Backend checkout facts retain absolute resource paths independently of the
/// machine running the presenter. Only the API adapter accepts legacy path text.
pub struct Worktree {
    pub checkout_root: ResourceUri,
    pub path: ResourceUri,
    pub branch: Option<String>,
    pub head: String,
    pub current: bool,
    pub state: WorktreeState,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeState {
    Ready,
    ThreadOwned,
    Locked,
    Prunable,
    Invalid,
    MissingDirectory,
}
