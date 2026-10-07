//! Durable long-lived project catalogs without execution or authorization authority.

mod command;
mod coordinator;
mod error;
mod project;
mod reducer;
mod store;

pub use command::ProjectCommand;
pub use command::ProjectCommandRequest;
pub use coordinator::ProjectCommandDisposition;
pub use coordinator::ProjectCommandResult;
pub use coordinator::ProjectCoordinator;
pub use error::ProjectError;
pub use project::Project;
pub use project::ProjectRoot;
pub use project::ProjectStatus;
pub use store::ProjectCommit;
pub use store::ProjectStore;
pub use store::ProjectStoreError;
pub use store::ProjectStoreOutcome;

#[cfg(test)]
#[path = "project_tests.rs"]
mod tests;
