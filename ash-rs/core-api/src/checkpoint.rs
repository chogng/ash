use crate::CoreError;
use ash_protocol::ItemId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use ash_protocol::WorkspaceCheckpoint;

/// Snapshot reservation kept alive until its message batch commits or is abandoned.
pub trait CheckpointCapture: Send + Sync {
    fn workspace(&self) -> &WorkspaceCheckpoint;
    fn commit(&self);
}

/// Captures file evidence without reading or mutating Core's locked Thread state.
pub trait MessageCheckpointSource: Send + Sync {
    fn capture(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        item_id: &ItemId,
        event_id: &str,
    ) -> Result<Box<dyn CheckpointCapture>, CoreError>;
    fn release(&self, checkpoint: &ash_protocol::RepositoryCheckpoint) -> Result<(), CoreError>;
}
