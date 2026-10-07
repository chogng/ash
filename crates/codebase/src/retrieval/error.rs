use thiserror::Error;

/// Failure to validate or execute the required local side of code retrieval.
#[derive(Debug, Error)]
pub enum CodebaseRetrievalError {
    #[error("codebase-retrieval query is invalid: {0}")]
    InvalidQuery(&'static str),
    #[error("code retrieval sources belong to different directory roots")]
    RootMismatch,
    #[error("local codebase retrieval failed: {0}")]
    LocalIndex(#[from] crate::CodebaseError),
    #[error("codebase text search failed: {0}")]
    Grep(grep::Error),
    #[error("code retrieval was cancelled: {0}")]
    Cancelled(String),
}
