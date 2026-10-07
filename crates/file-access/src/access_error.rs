use crate::Permission;
use std::fmt;
use std::path::PathBuf;

/// Failure to mutate or freeze directory access.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AccessError {
    SubjectMismatch,
    RevisionConflict {
        expected: u64,
        actual: u64,
    },
    PermissionUnavailable {
        dir: PathBuf,
        permission: Permission,
    },
}

impl fmt::Display for AccessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SubjectMismatch => {
                formatter.write_str("grant subject does not match directory access owner")
            }
            Self::RevisionConflict { expected, actual } => write!(
                formatter,
                "directory access revision conflict: expected {expected}, actual {actual}"
            ),
            Self::PermissionUnavailable { dir, permission } => write!(
                formatter,
                "directory access is not authorized to {permission}: {}",
                dir.display()
            ),
        }
    }
}

impl std::error::Error for AccessError {}
