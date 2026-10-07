//! App Server exposure of the shared collaboration room contract.
//!
//! Room DTOs are owned by `ash-collaboration-contract` so the process-local App
//! Server and the durable remote host use one transport-neutral vocabulary.

pub use collaboration::DocumentCollaborationOpenParams;
pub use collaboration::DocumentCollaborationOpenResult;
pub use collaboration::DocumentCollaborationPresence;
pub use collaboration::DocumentCollaborationPresenceParams;
pub use collaboration::DocumentCollaborationPresenceReadParams;
pub use collaboration::DocumentCollaborationPresenceSnapshot;
pub use collaboration::DocumentCollaborationSnapshot;
pub use collaboration::DocumentCollaborationSubmitParams;
pub use collaboration::DocumentCollaborationSubmitResult;
pub use collaboration::DocumentCollaborationUpdate;
