use std::path::PathBuf;

use thiserror::Error;

/// Failures while committing or reading immutable attachment bytes.
#[derive(Debug, Error)]
pub enum AttachmentStoreError {
    #[error("attachment is too large")]
    TooLarge,
    #[error("attachment was not found")]
    NotFound,
    #[error("attachment content is corrupt")]
    Corrupt,
    #[error("attachment storage failed at {path}: {source}")]
    Storage {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

impl AttachmentStoreError {
    pub(crate) fn storage(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Storage {
            path: path.into(),
            source,
        }
    }
}
