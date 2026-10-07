use crate::SandboxKind;
use std::fmt;
use std::path::PathBuf;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SandboxError {
    OutsideDir(PathBuf),
    InvalidRelativePath(PathBuf),
    InvalidScope(String),
    /// The backend cannot represent this exact policy. No command has started
    /// and no host configuration may have changed when returning this error.
    UnsupportedPolicy(String),
    BackendUnavailable {
        backend: SandboxKind,
        message: String,
    },
    StartFailed {
        timing: crate::SandboxDenialTiming,
        message: String,
    },
    Io(String),
}

impl fmt::Display for SandboxError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OutsideDir(path) => {
                write!(formatter, "path is outside directory: {}", path.display())
            }
            Self::InvalidRelativePath(path) => {
                write!(
                    formatter,
                    "path must be a relative path without '..': {}",
                    path.display()
                )
            }
            Self::InvalidScope(message) => write!(formatter, "invalid sandbox scope: {message}"),
            Self::UnsupportedPolicy(message) => {
                write!(formatter, "unsupported sandbox policy: {message}")
            }
            Self::BackendUnavailable { backend, message } => {
                write!(formatter, "{backend:?} sandbox is unavailable: {message}")
            }
            Self::StartFailed { message, .. } => formatter.write_str(message),
            Self::Io(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for SandboxError {}

impl From<ash_file_access::DirPathError> for SandboxError {
    fn from(error: ash_file_access::DirPathError) -> Self {
        match error {
            ash_file_access::DirPathError::OutsideDir(path) => Self::OutsideDir(path),
            ash_file_access::DirPathError::InvalidRelativePath(path) => {
                Self::InvalidRelativePath(path)
            }
            error => Self::Io(error.to_string()),
        }
    }
}
