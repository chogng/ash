//! Structured Git repository operations for Ash hosts.
//!
//! This crate owns invocation and parsing of the system Git executable. It does not own
//! App Server repository lifecycles, model tool authorization, or desktop presentation.

mod client;
mod discovery;
mod error;
mod fsmonitor;
mod history;
mod objects;
mod operation_lock;
mod path;
mod references;
mod remote;
mod repository;
mod working_copy;
mod worktree;

pub use client::GitClient;
pub use client::GitExecutionLimits;
pub use error::GitError;
pub use error::GitResult;
pub use history::GitCommitChange;
pub use history::GitCommitDetails;
pub use history::GitCommitFile;
pub use history::GitCommitStatistics;
pub use history::GitCommitSummary;
pub use history::GitComparisonMode;
pub use history::GitGraph;
pub use history::GitGraphCursor;
pub use history::GitReference;
pub use history::GitReferenceKind;
pub use objects::GitPackBase;
pub use objects::GitPrivateRef;
pub use objects::GitTreeChange;
pub use objects::GitTreeChangeKind;
pub use objects::GitTreeId;
pub use objects::GitTreeTextDiff;
pub use operation_lock::repository_operation_lock;
pub use references::GitBranch;
pub use references::GitCatalog;
pub use references::GitCommand;
pub use references::GitCommandOutcome;
pub use references::GitIntegration;
pub use references::GitReferenceState;
pub use references::GitStashMode;
pub use remote::GitRemote;
pub use remote::GitRemoteIdentity;
pub use remote::GitRemoteProvider;
pub use repository::GitRepository;
pub use repository::GitRepositoryKind;
pub use working_copy::GitChangeFile;
pub use working_copy::GitChangeFileComparison;
pub use working_copy::GitChangeStatus;
pub use working_copy::GitCommitRequest;
pub use working_copy::GitCommitResult;
pub use working_copy::GitConflictChoice;
pub use working_copy::GitConflictFile;
pub use working_copy::GitDiffStatistics;
pub use working_copy::GitFileRevision;
pub use working_copy::GitHead;
pub use working_copy::GitIndexDiff;
pub use working_copy::GitIndexEdit;
pub use working_copy::GitIndexSelection;
pub use working_copy::GitPatchDirection;
pub use working_copy::GitPatchDisposition;
pub use working_copy::GitPatchExecution;
pub use working_copy::GitPatchRequest;
pub use working_copy::GitPatchResult;
pub use working_copy::GitPathspecSet;
pub use working_copy::GitRepositoryChange;
pub use working_copy::GitRepositorySnapshot;
pub use working_copy::GitSubmoduleState;
pub use working_copy::GitTextDiff;
pub use working_copy::GitTextDiffLimits;
pub use working_copy::GitTextDiffSnapshot;
pub use working_copy::GitUpstream;
pub use working_copy::extract_patch_paths;
pub use worktree::GitDetachedWorktreeRequest;
pub use worktree::GitNamedWorktreeRequest;
pub use worktree::GitWorktree;
pub use worktree::GitWorktreeAvailability;
pub use worktree::GitWorktreeRemovalMode;

#[cfg(test)]
#[path = "test_support.rs"]
mod test_support;

pub use objects::GitTreeReplayResult;
