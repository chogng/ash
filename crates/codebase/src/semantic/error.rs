use std::fmt;

use thiserror::Error;

/// Redacted failure returned by a vector-store implementation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodebaseVectorStoreError {
    message: String,
}

impl CodebaseVectorStoreError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for CodebaseVectorStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CodebaseVectorStoreError {}

/// Failure to synchronize or query one local semantic codebase generation.
#[derive(Debug, Error)]
pub enum CodebaseSemanticError {
    #[error("semantic codebase input is invalid: {0}")]
    InvalidInput(&'static str),
    #[error("the local Codebase has not published a generation yet")]
    IndexNotReady,
    #[error("semantic codebase operation was cancelled")]
    Cancelled,
    #[error("semantic model returned an invalid response: {0}")]
    InvalidModelResponse(&'static str),
    #[error("local codebase access failed: {0}")]
    LocalIndex(#[from] crate::CodebaseError),
    #[error("semantic model invocation failed: {0}")]
    Model(#[from] ash_model_provider::ModelProviderError),
    #[error("semantic vector store failed: {0}")]
    VectorStore(#[from] CodebaseVectorStoreError),
}
