/// Construction, validation, queue, or shutdown failure at the product language-service boundary.
#[derive(Debug, thiserror::Error)]
pub enum LspManagerError {
    #[error("language-service document path must not be empty")]
    InvalidDocumentPath,
    #[error("invalid language ID `{0}`")]
    InvalidLanguageId(String),
    #[error("duplicate language server `{0}`")]
    DuplicateServer(String),
    #[error("language ID `{0}` is routed by more than one server")]
    DuplicateLanguage(String),
    #[error("directory root cannot be represented as a file URI: {0}")]
    InvalidDir(String),
    #[error("document path cannot be represented as a file URI: {0}")]
    InvalidDocumentUri(String),
    #[error("language-service supervisor is closed")]
    Closed,
    #[error("could not start language-service runtime: {0}")]
    RuntimeStart(std::io::Error),
    #[error("language-service supervisor did not shut down in time")]
    ShutdownTimeout,
    #[error(transparent)]
    Router(#[from] ash_lsp::LanguageServerRouterError),
}
