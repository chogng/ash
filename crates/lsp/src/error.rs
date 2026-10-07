use std::time::Duration;

/// Failures produced while starting, using, or shutting down one language server.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum LanguageServerError {
    #[error("failed to start language server: {0}")]
    Start(#[source] std::io::Error),
    #[error("language server transport failed: {0}")]
    Transport(#[source] std::io::Error),
    #[error("language server message is invalid: {0}")]
    InvalidMessage(String),
    #[error("language server message exceeds the {limit}-byte limit")]
    MessageTooLarge { limit: usize },
    #[error("language server {operation} timed out after {duration:?}")]
    Timeout {
        operation: String,
        duration: Duration,
    },
    #[error("language server request {operation} was cancelled")]
    Cancelled { operation: String },
    #[error("language server rejected {method} with {code}: {message}")]
    Response {
        method: String,
        code: i64,
        message: String,
        data: Option<serde_json::Value>,
    },
    #[error("language server response for {method} has an invalid result: {source}")]
    InvalidResult {
        method: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("language server connection closed")]
    ConnectionClosed,
    #[error("language server is not ready")]
    NotReady,
    #[error("language server is shutting down")]
    ShuttingDown,
    #[error("document `{0}` is already open")]
    DocumentAlreadyOpen(String),
    #[error("document `{0}` is not open")]
    DocumentNotOpen(String),
    #[error("language server does not support {0}")]
    UnsupportedDocumentOperation(&'static str),
    #[error("language server requires full-document changes")]
    FullDocumentChangeRequired,
    #[error("document version overflowed")]
    DocumentVersionOverflow,
    #[error("language server requested saved document text")]
    SavedDocumentTextRequired,
    #[error("language server did not request saved document text")]
    SavedDocumentTextNotSupported,
}
