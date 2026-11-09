//! Handle-derived, domain-neutral identity and hard-link information for open files.

#![deny(unsafe_code)]

use std::fs::File;
use std::io;
use std::path::Path;
use std::path::PathBuf;

#[cfg(unix)]
#[path = "unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "windows.rs"]
mod platform;

/// Filesystem identity used to compare observations within one validation operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
struct FileIdentity {
    volume: u64,
    object: [u8; 16],
}

/// Identity and hard-link count captured from one open file handle.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct FileInformation {
    identity: FileIdentity,
    number_of_links: u64,
}

impl FileInformation {
    /// Captures identity and link count from an already-open file without reopening its path.
    pub fn from_file(file: &File) -> io::Result<Self> {
        platform::inspect(file)
    }

    /// Opens a path and captures identity and link count from the resulting handle.
    ///
    /// This follows symbolic links and represents only this point-in-time observation. Callers
    /// that make a trust decision about later reads must inspect the handle used for that read
    /// with [`Self::from_file`] and compare the two observations.
    pub fn from_path(path: impl AsRef<Path>) -> io::Result<Self> {
        #[cfg(unix)]
        let file = File::open(path)?;
        #[cfg(windows)]
        let file = platform::open_for_inspection(path.as_ref())?;
        Self::from_file(&file)
    }

    /// Observes a path's identity and canonical location for callers that validate both.
    ///
    /// On Windows both values come from one handle. Callers must still verify the
    /// handle used to read bytes, and recheck the path if it can change during the read.
    pub fn from_path_with_canonical(path: &Path) -> io::Result<(Self, PathBuf)> {
        #[cfg(windows)]
        {
            let file = platform::open_for_inspection(path)?;
            Ok((Self::from_file(&file)?, platform::canonical_path(&file)?))
        }
        #[cfg(unix)]
        Ok((Self::from_path(path)?, path.canonicalize()?))
    }

    /// Returns whether both contemporaneous observations identify the same filesystem object.
    ///
    /// This is not a durable object key: callers must not persist the result across deletion,
    /// replacement, filesystem remounts, or process restarts.
    pub fn same_file_as(self, other: Self) -> bool {
        self.identity == other.identity
    }

    /// Returns whether the observed filesystem object has more than one hard link.
    pub fn has_multiple_links(self) -> bool {
        self.number_of_links > 1
    }

    pub(crate) fn new(volume: u64, object: [u8; 16], number_of_links: u64) -> Self {
        Self {
            identity: FileIdentity { volume, object },
            number_of_links,
        }
    }
}

#[cfg(test)]
#[path = "file_identity_tests.rs"]
mod tests;

/// Resolves the OS-owned shared application-data location, without trusting process environment.
#[cfg(windows)]
pub fn common_application_data_dir() -> io::Result<std::path::PathBuf> {
    platform::common_application_data_dir()
}

/// Returns the normalized Windows name of the opened entry, including a link opened without following it.
#[cfg(windows)]
pub fn canonical_path_from_handle(file: &File) -> io::Result<PathBuf> {
    platform::canonical_path(file)
}

/// Checks administrator/System ownership and denies effective write grants to other principals.
/// The handle being inspected is also the handle the caller must use to read the authority file.
#[cfg(windows)]
pub fn validate_administrator_owned(file: &File) -> io::Result<()> {
    platform::validate_administrator_owned(file)
}
