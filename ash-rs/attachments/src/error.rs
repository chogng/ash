use std::path::PathBuf;

use thiserror::Error;

/// Stable failures produced while admitting, storing, or resolving an attachment.
#[derive(Debug, Error)]
pub enum AttachmentError {
    #[error("invalid image attachment: {0}")]
    InvalidImage(String),
    #[error("invalid audio attachment: {0}")]
    InvalidAudio(String),
    #[error("attachment is too large")]
    TooLarge,
    #[error("attachment was not found")]
    NotFound,
    #[error("attachment content is corrupt")]
    Corrupt,
    #[error("remote image import is unavailable")]
    RemoteUnavailable,
    #[error("remote image import failed")]
    RemoteFetch,
    #[error("attachment storage failed at {path}: {source}")]
    Storage {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

impl AttachmentError {
    pub(crate) fn storage(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Storage {
            path: path.into(),
            source,
        }
    }
}
