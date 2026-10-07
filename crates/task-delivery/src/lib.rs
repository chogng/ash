//! Durable task packages and links between independent execution histories.
//! Queue and Core remain the only owners of message delivery and Turn execution state.
#[cfg(feature = "runtime")]
mod runtime;
#[cfg(feature = "runtime")]
mod store;
#[cfg(feature = "runtime")]
pub use runtime::Peer;
#[cfg(feature = "runtime")]
pub use runtime::PeerFuture;
#[cfg(feature = "runtime")]
pub use runtime::Runtime;
#[cfg(feature = "runtime")]
pub use runtime::RuntimeServices;
#[cfg(feature = "runtime")]
pub use runtime::SendTask;
#[cfg(feature = "runtime")]
pub use store::OutgoingTask;
#[cfg(feature = "runtime")]
pub use store::Store;

pub use contract::CodeSnapshot;
pub use contract::Error;
pub use contract::MAX_PACK_BYTES;
pub use contract::MAX_TEXT_BYTES;
pub use contract::Result;
pub use contract::SnapshotInfo;
pub use contract::SourceTask;
pub use contract::TaskPackage;
pub use contract::TaskReadParams;
pub use contract::TaskReceipt;
pub use contract::TaskReport;
pub use contract::digest;
