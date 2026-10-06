//! Durable domain model for Git repository changes attributed to one Turn.

mod commit;
mod ledger;
mod model;
mod store;
mod watcher;

pub use model::CaptureState;
pub use model::ChangeFile;
pub use model::ChangeFileKind;
pub use model::ChangeSetId;
pub use model::CommitState;
pub use model::MessageState;
pub use model::TerminalTurnState;
pub use model::TurnChangeError;
pub use model::TurnChangeSet;
pub use model::TurnChangeSetDraft;
pub use store::TurnChangeStore;
pub use store::TurnChangeStoreError;

#[cfg(test)]
#[path = "turn_changes_tests.rs"]
mod tests;
pub use ledger::MessageCaptureTarget;
pub use ledger::RepositoryCaptureTarget;
pub use ledger::ToolChangeScope;
pub use ledger::TurnChangeBeginRequest;
pub use ledger::TurnChangeLedger;
pub use ledger::TurnChangeLedgerError;
pub use ledger::TurnChangeSealRequest;
pub use ledger::change_file;
pub use ledger::relocate_capture_objects;
pub use watcher::GitTurnChangeWatcher;
pub use watcher::WriteCheckpointLease;
pub use watcher::WriteLifecycleTracker;

pub use commit::TurnCommitRecord;
pub use commit::TurnCommitSelection;
pub use commit::TurnCommitSource;
pub use commit::TurnCommitState;
pub use commit::TurnCommitStore;
pub use commit::TurnPublication;
pub use commit::commit_transaction_id;
pub use commit::derive_commit_progress;
pub use commit::prepare_selection;
pub use commit::publish_selection;
pub use commit::validate_selection;

pub use commit::queued_publication;
pub use commit::validate_publication_update;

pub use commit::require_settled_publications;
