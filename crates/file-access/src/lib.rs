//! Directory identity, grants, authorization decisions, and checked operation authorizations.
//!
//! This crate deliberately does not own editor, Git, terminal, MCP, LSP, configuration
//! persistence, approval UI, or sandbox execution. Hosts establish a [`Dir`], issue an explicit
//! [`Grant`], evaluate an [`AuthorizationDecision`], and pass an allowed [`Authorization`] only to
//! an operation that validates the complete binding and holds its revocation lease during I/O.

mod access;
mod access_error;
mod binding;
mod dir;
mod dir_entry;
mod dir_id;
mod grant;
mod snapshot;

pub use access::Access;
pub use access_error::AccessError;
pub use ash_environment::EnvId;
pub use ash_environment::EnvIdError;
pub use binding::DirBinding;
pub use dir::Dir;
pub use dir::DirPathError;
pub use dir_entry::DirEntry;
pub use dir_entry::DirSource;
pub use dir_id::DirId;
pub use dir_id::DirIdError;
pub use grant::Authorization;
pub use grant::AuthorizationDecision;
pub use grant::Grant;
pub use grant::GrantSource;
pub use grant::GrantSubject;
pub use grant::Permission;
pub use grant::PermissionDenied;
pub use grant::Permissions;
pub use snapshot::Mutation;
pub use snapshot::Revision;
pub use snapshot::Snapshot;
