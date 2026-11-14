//! App Server exposure of the shared collaboration room contract.
//!
//! Room DTOs are owned by `ash-collab-contract` so the process-local App
//! Server and the durable remote host use one transport-neutral vocabulary.

pub use collaboration::RoomOpenParams;
pub use collaboration::RoomOpenResult;
pub use collaboration::RoomPresence;
pub use collaboration::RoomPresenceParams;
pub use collaboration::RoomPresenceReadParams;
pub use collaboration::RoomPresenceSnapshot;
pub use collaboration::RoomSnapshot;
pub use collaboration::RoomSubmitParams;
pub use collaboration::RoomSubmitResult;
pub use collaboration::RoomUpdate;

pub use collaboration::channels::*;

pub use collaboration::RoomStatus;
pub use collaboration::RoomStatusParams;
