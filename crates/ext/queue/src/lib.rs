//! Durable FIFO messages and leased delivery to the existing Turn owner.

mod extension;
pub use extension::install;
mod runtime;
mod store;
pub use runtime::Delivery;
pub use runtime::QueueExecutor;
pub use runtime::QueueRuntime;
pub use store::QueueStore;

pub use contract::QueueEdit;
pub use contract::QueueInput;
pub use contract::QueueMove;
pub use contract::QueueStatus;
pub use contract::QueuedMessage;

#[derive(Debug, thiserror::Error)]
pub enum QueueError {
    #[error("invalid queued message: {0}")]
    Invalid(String),
    #[error("queued message not found")]
    NotFound,
    #[error("queued message conflicts with an accepted command")]
    Conflict,
    #[error("queued message is being delivered")]
    Busy,
    #[error("queue storage failed: {0}")]
    Storage(String),
}

impl From<rusqlite::Error> for QueueError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(error.to_string())
    }
}
impl From<serde_json::Error> for QueueError {
    fn from(error: serde_json::Error) -> Self {
        Self::Storage(error.to_string())
    }
}
