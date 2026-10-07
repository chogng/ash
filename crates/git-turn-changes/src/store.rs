use crate::ChangeSetId;
use crate::TurnChangeSet;
use ash_protocol::ThreadId;

/// Persistence boundary for complete Git Turn change-set records.
///
/// Implementations must compare revisions atomically and must never merge fields from competing
/// writers. App Server retries by reloading the complete winning record.
pub trait TurnChangeStore: Send + Sync {
    fn insert(&self, change_set: &TurnChangeSet) -> Result<(), TurnChangeStoreError>;

    fn load(&self, change_set_id: &ChangeSetId) -> Result<TurnChangeSet, TurnChangeStoreError>;

    fn list_for_thread(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Vec<TurnChangeSet>, TurnChangeStoreError>;

    fn compare_and_swap(
        &self,
        expected_revision: u64,
        change_set: &TurnChangeSet,
    ) -> Result<(), TurnChangeStoreError>;
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum TurnChangeStoreError {
    #[error("change set was not found: {0}")]
    NotFound(String),
    #[error("change set already exists: {0}")]
    AlreadyExists(String),
    #[error("change-set revision conflict: expected {expected}, actual {actual}")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error("command ID was already used for different parameters: {0}")]
    CommandConflict(String),
    #[error("turn change storage failed: {0}")]
    Storage(String),
}
