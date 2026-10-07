//! Immutable base generations with atomically selected change-layer snapshots.

#![deny(unsafe_code)]

mod generation_file;
mod layout;
mod store;

pub use generation_file::OpenGenerationFile;
pub use store::CleanupReport;
pub use store::ExpectedCurrent;
pub use store::GenerationFile;
pub use store::ImmutableGenerationStore;
pub use store::PublishError;
pub use store::PublishOutcome;
pub use store::PublishReport;
pub use store::PublishedSnapshot;
