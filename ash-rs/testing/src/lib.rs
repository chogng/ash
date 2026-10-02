//! Workspace Rust test discovery and exact harness execution under directory permissions.
//! Catalogs and runs belong to one connection and stop when that connection closes.

//! The domain owns test identities and results; process lifetime and cancellation use the
//! execution layer. Editor buffers, UI state and extension objects remain with their consumers.

mod discovery;
mod doctest;
mod model;
mod runner;
mod service;

pub use model::DebugLaunch;
pub use model::OperationKind;
pub use model::OperationStatus;
pub use model::Snapshot;
pub use model::TargetKind;
pub use model::TestItem;
pub use model::TestResult;
pub use model::TestSource;
pub use model::TestState;
pub use model::Update;
pub use service::TestingError;
pub use service::TestingService;

#[cfg(test)]
mod tests;
