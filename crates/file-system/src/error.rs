use std::fmt;
use std::path::PathBuf;

/// Failure returned by a directory-scoped filesystem implementation.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum FileSystemError {
    PermissionDenied(String),
    OsPermissionDenied(String),
    ElevationDenied,
    ElevationUnavailable,
    ElevationTimedOut,
    ElevationFailed,
    Cancelled,
    WriteOutcomeUnknown,
    InvalidPath(PathBuf),
    NotFile(PathBuf),
    NotDirectory(PathBuf),
    ReadLimitExceeded { maximum_bytes: usize },
    WriteLimitExceeded { maximum_bytes: usize },
    RevisionConflict(PathBuf),
    ReadOnly(PathBuf),
    AlreadyExists(PathBuf),
    NotFound(PathBuf),
    Io(String),
}

impl fmt::Display for FileSystemError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath(path) => {
                write!(
                    formatter,
                    "path is outside the authorized directory: {}",
                    path.display()
                )
            }
            Self::NotFile(path) => {
                write!(formatter, "path is not a file: {}", path.display())
            }
            Self::NotDirectory(path) => {
                write!(formatter, "path is not a directory: {}", path.display())
            }
            Self::ReadLimitExceeded { maximum_bytes } => {
                write!(
                    formatter,
                    "file exceeds the {maximum_bytes}-byte read limit"
                )
            }
            Self::WriteLimitExceeded { maximum_bytes } => {
                write!(
                    formatter,
                    "content exceeds the {maximum_bytes}-byte write limit"
                )
            }
            Self::RevisionConflict(path) => {
                write!(
                    formatter,
                    "file changed since the expected revision: {}",
                    path.display()
                )
            }
            Self::ReadOnly(path) => {
                write!(formatter, "path is read-only: {}", path.display())
            }
            Self::AlreadyExists(path) => {
                write!(formatter, "path already exists: {}", path.display())
            }
            Self::NotFound(path) => {
                write!(formatter, "path does not exist: {}", path.display())
            }
            Self::ElevationDenied => formatter.write_str("system authorization was declined"),
            Self::ElevationUnavailable => formatter.write_str("system elevation is unavailable"),
            Self::ElevationTimedOut => formatter.write_str("system authorization timed out"),
            Self::ElevationFailed => formatter.write_str("system authorization or the file helper failed"),
            Self::Cancelled => formatter.write_str("file write was cancelled before publication"),
            Self::WriteOutcomeUnknown => formatter.write_str("the elevated write outcome could not be confirmed; reload the file before retrying"),
            Self::PermissionDenied(message) | Self::OsPermissionDenied(message) | Self::Io(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for FileSystemError {}
