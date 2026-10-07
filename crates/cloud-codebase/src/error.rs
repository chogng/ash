use thiserror::Error;

/// Non-secret failure returned by one concrete cloud codebase provider adapter.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
#[error("{message}")]
pub struct CloudCodebaseProviderError {
    message: String,
}

impl CloudCodebaseProviderError {
    /// Creates a redacted provider failure safe for local diagnostics.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// Failure to preview, authorize, publish, recover, or delete a cloud index projection.
#[derive(Debug, Error)]
pub enum CloudCodebaseError {
    #[error("cloud codebase input is invalid: {0}")]
    InvalidInput(&'static str),
    #[error("cloud codebase storage belongs to another directory root")]
    StorageRootMismatch,
    #[error("cloud codebase storage schema is incompatible")]
    IncompatibleStorage,
    #[error("another cloud codebase grant must be revoked before this grant can be activated")]
    ConsentConflict,
    #[error("cloud codebase provider is unavailable")]
    ProviderUnavailable,
    #[error("cloud codebase provider does not guarantee idempotent grant deletion")]
    DeletionUnsupported,
    #[error("cloud codebase preview exceeds the grant byte limit")]
    EgressLimitExceeded,
    #[error("local Codebase has no published generation")]
    LocalIndexNotReady,
    #[error("cloud codebase has no active grant")]
    NoActiveGrant,
    #[error("cloud codebase operation conflicts with the current lifecycle state")]
    InvalidState,
    #[error("cloud codebase provider returned an invalid query result: {0}")]
    InvalidProviderResult(&'static str),
    #[error("cloud codebase provider operation failed: {0}")]
    Provider(#[from] CloudCodebaseProviderError),
    #[error("local codebase operation failed: {0}")]
    LocalIndex(#[from] ash_codebase::CodebaseError),
    #[error("cloud codebase storage failed: {0}")]
    Storage(#[from] rusqlite::Error),
    #[error("cloud codebase database runtime failed: {0}")]
    DatabaseRuntime(String),
    #[error("cloud codebase state serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
}
