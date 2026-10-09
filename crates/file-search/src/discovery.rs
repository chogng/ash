//! Directory admission shared by the disk walker and the indexed filename catalog.

pub(crate) const EXCLUDED_DIRECTORIES: &[&str] = &[".git", ".ash", "node_modules", "target"];
