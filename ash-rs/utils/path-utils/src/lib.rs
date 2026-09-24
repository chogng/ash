//! Canonical containment, constrained relative paths, and atomic writes on the host filesystem.

mod canonical_root;
mod persistence;
mod relative;

pub use canonical_root::CanonicalContainmentError;
pub use canonical_root::CanonicalPathRoot;
pub use canonical_root::NoSymlinkPathError;
pub use canonical_root::NoSymlinkPathStatus;
pub use persistence::write_atomically;
pub use relative::join_descendant;

#[cfg(test)]
#[path = "path_utils_tests.rs"]
mod tests;
