//! Built-in and directory-defined Agent roles.
//!
//! This crate owns immutable role definitions, their model-facing instructions, capability
//! declarations, and bounded discovery below `.ash/agents`. It does not create Threads, invoke
//! models, resolve tools, grant permissions, or coordinate Agents.

mod assets;
mod catalog;
mod definition;
mod model;

pub use assets::built_in_roles;
pub use catalog::AgentRoleCatalog;
pub use model::AgentRole;
pub use model::AgentRoleCatalogSnapshot;
pub use model::AgentRoleDiagnostic;
pub use model::AgentRoleDiagnosticCode;
pub use model::AgentRoleSource;
pub use model::RoleLaunch;
