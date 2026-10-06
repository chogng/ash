//! Shared, backend-owned authority for ordered structured-document collaboration rooms.
//!
//! [`InMemoryDocumentCollaborationRooms`] is the App Server's local-process
//! implementation. [`SqliteDocumentCollaborationRooms`] is the durable room
//! authority used by a remote collaboration host. Both enforce the exact same
//! room, version, bounded-history, and replay semantics.

mod in_memory;
mod room;
mod sqlite;

pub use contract::DocumentCollaborationAuditEvent;
pub use contract::DocumentCollaborationInvite;
pub use contract::DocumentCollaborationMember;
pub use contract::DocumentCollaborationOpenParams;
pub use contract::DocumentCollaborationOpenResult;
pub use contract::DocumentCollaborationPresence;
pub use contract::DocumentCollaborationPresenceParams;
pub use contract::DocumentCollaborationPresenceReadParams;
pub use contract::DocumentCollaborationPresenceReplay;
pub use contract::DocumentCollaborationPresenceSnapshot;
pub use contract::DocumentCollaborationPrincipal;
pub use contract::DocumentCollaborationRoomRole;
pub use contract::DocumentCollaborationSnapshot;
pub use contract::DocumentCollaborationSubmitParams;
pub use contract::DocumentCollaborationSubmitResult;
pub use contract::DocumentCollaborationUpdate;
pub use in_memory::InMemoryDocumentCollaborationRooms;
pub use room::DocumentCollaborationReplay;
pub use sqlite::SqliteDocumentCollaborationRooms;

#[cfg(test)]
#[path = "in_memory_tests.rs"]
mod in_memory_tests;

#[cfg(test)]
#[path = "sqlite_tests.rs"]
mod sqlite_tests;
