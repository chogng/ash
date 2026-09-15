//! Host-filesystem path comparison, canonical containment, symlink-aware write targeting,
//! and atomic writes.

mod canonical_root;
mod comparison;
mod environment;
mod persistence;
mod relative;

pub use canonical_root::CanonicalContainmentError;
pub use canonical_root::CanonicalPathRoot;
pub use canonical_root::NoSymlinkPathError;
pub use canonical_root::NoSymlinkPathStatus;
pub use comparison::normalize_for_native_workdir;
pub use comparison::normalize_for_path_comparison;
pub use comparison::paths_match_after_normalization;
pub use environment::is_wsl;
pub use persistence::resolve_symlink_write_path;
pub use persistence::write_atomically;
pub use persistence::write_text_atomically;
pub use relative::join_descendant;

#[cfg(test)]
#[path = "path_utils_tests.rs"]
mod tests;
