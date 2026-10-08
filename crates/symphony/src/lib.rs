//! Durable workflow scheduling. Core remains the sole conversation and execution owner.

mod runtime;
mod store;
mod workflow;

pub use runtime::Executor;
pub use runtime::Runtime;
pub use runtime::now;
pub use store::Job;
pub use store::Observation;
pub use store::Store;
pub use workflow::Issue;
pub use workflow::Tracker;
pub use workflow::Workflow;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid workflow: {0}")]
    Invalid(String),
    #[error("workflow or conversation not found")]
    NotFound,
    #[error("workflow command conflicts with an earlier command")]
    Conflict,
    #[error("workflow storage: {0}")]
    Storage(#[from] rusqlite::Error),
    #[error("workflow record: {0}")]
    Record(#[from] serde_json::Error),
    #[error("workflow storage lock poisoned")]
    LockPoisoned,
}

#[cfg(test)]
mod tests;
