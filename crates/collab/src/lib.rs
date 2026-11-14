//! Shared, backend-owned authority for ordered structured-document collaboration rooms.
//!
//! [`MemoryRoomStore`] is the App Server's local-process
//! implementation. [`SqliteRoomStore`] is the durable room
//! authority used by a remote collaboration host. Both enforce the exact same
//! room, version, bounded-history, and replay semantics.

pub mod channel_client;
pub mod channels;
mod in_memory;
mod markdown;
mod room;
mod sqlite;

pub use contract::RoomAuditEvent;
pub use contract::RoomInvite;
pub use contract::RoomMember;
pub use contract::RoomOpenParams;
pub use contract::RoomOpenResult;
pub use contract::RoomPresence;
pub use contract::RoomPresenceParams;
pub use contract::RoomPresenceReadParams;
pub use contract::RoomPresenceReplay;
pub use contract::RoomPresenceSnapshot;
pub use contract::RoomPrincipal;
pub use contract::RoomRole;
pub use contract::RoomSnapshot;
pub use contract::RoomStatus;
pub use contract::RoomStatusParams;
pub use contract::RoomSubmitParams;
pub use contract::RoomSubmitResult;
pub use contract::RoomUpdate;
pub use in_memory::MemoryRoomStore;
pub use room::RoomReplay;
pub use sqlite::SqliteRoomStore;

#[cfg(test)]
#[path = "in_memory_tests.rs"]
mod in_memory_tests;

#[cfg(test)]
#[path = "sqlite_tests.rs"]
mod sqlite_tests;

#[cfg(test)]
mod markdown_tests;
