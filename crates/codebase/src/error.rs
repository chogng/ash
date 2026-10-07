use std::path::PathBuf;

use ash_file_access::DirPathError;
use thiserror::Error;

use crate::SourceRevision;

/// Failure to open, update, query, or verify a Codebase.
#[derive(Debug, Error)]
pub enum CodebaseError {
    #[error("invalid codebase limits: {0}")]
    InvalidLimits(&'static str),
    #[error("codebase query is invalid: {0}")]
    InvalidQuery(&'static str),
    #[error("codebase identity is invalid: {0}")]
    InvalidIdentity(&'static str),
    #[error("codebase storage belongs to another directory root")]
    StorageRootMismatch,
    #[error("codebase storage failed: {0}")]
    Storage(String),
    #[error("filesystem operation failed for {}: {source}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error(transparent)]
    DirPath(#[from] DirPathError),
    #[error("indexed source revision is stale (expected {expected}, observed {observed})")]
    StaleRevision {
        expected: SourceRevision,
        observed: SourceRevision,
    },
    #[error("current source exceeds the codebase verification byte limit")]
    SourceVerificationLimitExceeded,
    #[error("indexed chunk range is not valid for the current UTF-8 source")]
    InvalidChunkRange,
    #[error("indexed chunk line coverage does not match its byte range")]
    ChunkSpanMismatch,
    #[error("indexed chunk content no longer matches its stable identity")]
    ChunkIdentityMismatch,
    #[error("directory document overlay path is not an authorized relative source path")]
    InvalidOverlayPath,
    #[error("directory document overlay revision does not advance consistently")]
    OverlayRevisionConflict,
    #[error("a dirty document overlay supersedes the requested persistent source revision")]
    OverlaySupersedesPersistentSource,
}

impl CodebaseError {
    #[doc(hidden)]
    pub fn storage(error: impl std::fmt::Display) -> Self {
        Self::Storage(error.to_string())
    }
}

pub(crate) fn io_error(path: impl Into<PathBuf>, source: std::io::Error) -> CodebaseError {
    CodebaseError::Io {
        path: path.into(),
        source,
    }
}
