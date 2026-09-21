// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Host mutation authority is independent of the sandbox's readable paths.

use std::path::Path;
use std::path::PathBuf;

/// The host paths on which an embedding application authorized ACL changes.
/// This value is never deserialized from a sandbox command or policy document.
#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct HostAclScope {
    objects: crate::filesystem_object::FilesystemSnapshot,
}

impl HostAclScope {
    /// Resolve the independently authorized roots before preparing execution.
    pub fn new(paths: impl IntoIterator<Item = PathBuf>) -> std::io::Result<Self> {
        Ok(Self {
            objects: crate::filesystem_object::FilesystemSnapshot::capture(paths)?,
        })
    }

    /// Require the actual target to remain inside the authorized roots.
    /// Missing, inaccessible, and redirected targets do not acquire authority.
    pub fn check(&self, path: &Path) -> std::io::Result<()> {
        self.objects.validate()?;
        let target = std::fs::canonicalize(path)?;
        if self.objects.paths().any(|root| target.starts_with(root)) {
            Ok(())
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!(
                    "host ACL changes were not authorized for '{}'",
                    path.display()
                ),
            ))
        }
    }
}

#[cfg(test)]
#[path = "host_changes_tests.rs"]
mod tests;
