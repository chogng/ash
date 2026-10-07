/// Static server-definition or executable-name validation failure.
#[derive(Debug, thiserror::Error)]
pub enum LspServerResolverError {
    #[error(transparent)]
    InvalidExecutableName(#[from] ash_install_context::InvalidHostExecutableName),
    #[error(transparent)]
    InvalidDefinition(Box<ash_lsp::LanguageServerRouterError>),
}

impl From<ash_lsp::LanguageServerRouterError> for LspServerResolverError {
    fn from(error: ash_lsp::LanguageServerRouterError) -> Self {
        Self::InvalidDefinition(Box::new(error))
    }
}
