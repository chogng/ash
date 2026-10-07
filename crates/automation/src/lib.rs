//! Durable automation plans and scheduling, independent of Agent execution and transport.

mod runtime;
mod schedule;
mod store;

pub use runtime::AutomationExecutor;
pub use runtime::AutomationRuntime;
pub use runtime::now;
pub use schedule::next_occurrence;
pub use schedule::validate_definition;
pub use store::AutomationStore;
pub use store::AutomationWrite;

#[derive(Debug, thiserror::Error)]
pub enum AutomationError {
    #[error("invalid automation: {0}")]
    Invalid(String),
    #[error("automation not found")]
    NotFound,
    #[error("automation revision conflict")]
    Conflict,
    #[error("automation is already running")]
    Busy,
    #[error("automation request identity was reused with different content")]
    CommandConflict,
    #[error("automation storage: {0}")]
    Storage(#[from] rusqlite::Error),
    #[error("automation record: {0}")]
    Record(#[from] serde_json::Error),
    #[error("automation storage lock is poisoned")]
    LockPoisoned,
}
