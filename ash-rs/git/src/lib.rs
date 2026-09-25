//! Structured Git repository operations for Ash hosts.
//!
//! This crate owns invocation and parsing of the system Git executable. It does not own
//! App Server repository lifecycles, model tool authorization, or desktop presentation.

mod branch;
mod client;
mod content;
mod discovery;
mod error;
mod fsmonitor;
mod graph;
mod history;
mod info;
mod mutation;
mod objects;
mod operation_lock;
mod patch;
mod path;
mod repository;
mod status;
mod text_diff;
mod tree_commit;
mod worktree;

pub use client::GitClient;
pub use client::GitExecutionLimits;
pub use content::GitChangeFile;
pub use content::GitChangeFileComparison;
pub use content::GitFileRevision;
pub use error::GitError;
pub use error::GitResult;
pub use graph::GitGraph;
pub use graph::GitGraphCursor;
pub use graph::GitReference;
pub use graph::GitReferenceKind;
pub use history::GitCommitChange;
pub use history::GitCommitFile;
pub use info::GitBranch;
pub use info::GitCommitSummary;
pub use info::GitRemote;
pub use info::GitRemoteIdentity;
pub use info::GitRemoteProvider;
pub use mutation::GitCommitRequest;
pub use mutation::GitCommitResult;
pub use mutation::GitPathspecSet;
pub use objects::GitPrivateRef;
pub use objects::GitTreeChange;
pub use objects::GitTreeChangeKind;
pub use objects::GitTreeId;
pub use objects::GitTreeTextDiff;
pub use operation_lock::repository_operation_lock;
pub use patch::GitPatchDirection;
pub use patch::GitPatchDisposition;
pub use patch::GitPatchExecution;
pub use patch::GitPatchRequest;
pub use patch::GitPatchResult;
pub use patch::extract_patch_paths;
pub use repository::GitRepository;
pub use repository::GitRepositoryKind;
pub use status::GitChangeStatus;
pub use status::GitHead;
pub use status::GitRepositoryChange;
pub use status::GitRepositorySnapshot;
pub use status::GitSubmoduleState;
pub use status::GitUpstream;
pub use text_diff::GitDiffStatistics;
pub use text_diff::GitTextDiff;
pub use text_diff::GitTextDiffLimits;
pub use text_diff::GitTextDiffSnapshot;
pub use tree_commit::GitPrepareTreeCommitResult;
pub use tree_commit::GitPreparedTreeCommit;
pub use tree_commit::GitPreparedTreeCommitRequest;
pub use tree_commit::GitTreeCommitConflict;
pub use tree_commit::GitTreeCommitRecovery;
pub use tree_commit::GitTreeCommitRequest;
pub use tree_commit::GitTreeCommitResult;
pub use tree_commit::GitTreeReplayResult;
pub use worktree::GitDetachedWorktreeRequest;
pub use worktree::GitNamedWorktreeRequest;
pub use worktree::GitWorktree;
pub use worktree::GitWorktreeAvailability;
pub use worktree::GitWorktreeRemovalMode;

#[cfg(test)]
#[path = "test_support.rs"]
mod test_support;
