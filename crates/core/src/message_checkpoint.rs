use ash_protocol::WorkspaceCheckpoint;
use core_api::CheckpointCapture;

pub(crate) struct NoFilesCapture(pub(crate) WorkspaceCheckpoint);
impl CheckpointCapture for NoFilesCapture {
    fn workspace(&self) -> &WorkspaceCheckpoint {
        &self.0
    }
    fn commit(&self) {}
}

pub(crate) struct PreparedThreadBatch {
    pub(crate) data: ash_thread_store::ThreadEventBatch,
    pub(crate) captures: Vec<Box<dyn CheckpointCapture>>,
}

impl std::ops::Deref for PreparedThreadBatch {
    type Target = ash_thread_store::ThreadEventBatch;
    fn deref(&self) -> &Self::Target {
        &self.data
    }
}
