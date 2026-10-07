//! Immutable Agent-environment values and deterministic model-context rendering.
//!
//! Hosts collect and authorize environment facts. This crate validates those facts, preserves
//! accessible-directory ordering, and renders the model-visible environment without owning Session
//! lifecycle, command execution, or access enforcement.

#[path = "model/dirs.rs"]
mod dirs;
#[path = "render/environment_context.rs"]
mod environment_context;
mod error;
mod time_context;
pub use time_context::TimeSnapshot;
pub use time_context::validate_time_zone;
#[path = "model/snapshot.rs"]
mod snapshot;

pub use dirs::Dirs;
pub use error::AgentEnvironmentError;
pub use snapshot::AgentEnvironmentSnapshot;
pub use snapshot::HostEnvironment;
pub use snapshot::RepositoryEnvironment;
