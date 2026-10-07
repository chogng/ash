use std::path::PathBuf;

use thiserror::Error;

/// Failure to open, reconcile, query, or persist a rebuildable symbol index.
#[derive(Debug, Error)]
pub enum SymbolIndexError {
    #[error("invalid symbol-index limits: {0}")]
    InvalidLimits(&'static str),
    #[error("symbol-index query exceeds its byte limit")]
    QueryTooLarge,
    #[error("symbol-index storage belongs to another directory root")]
    StorageRootMismatch,
    #[error("symbol-index source projection does not match the current codebase root")]
    SourceRootMismatch,
    #[error("symbol-index storage contains an unknown symbol kind: {0}")]
    InvalidStoredSymbolKind(String),
    #[error("symbol-index storage failed: {0}")]
    Storage(String),
    #[error("symbol extraction failed for {}: {source}", path.display())]
    Syntax {
        path: PathBuf,
        #[source]
        source: ash_syntax::SyntaxError,
    },
    #[error("symbol-index operation was cancelled: {0}")]
    Cancelled(String),
    #[error(transparent)]
    Codebase(#[from] crate::CodebaseError),
}

impl SymbolIndexError {
    #[doc(hidden)]
    pub fn storage(error: impl std::fmt::Display) -> Self {
        Self::Storage(error.to_string())
    }
}
