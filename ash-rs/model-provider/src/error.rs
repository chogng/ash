use ash_api::ApiError;
use ash_model_provider_config::{ModelId, ProviderConfigError, ProviderId};
use ash_secrets::SecretStoreError;
use std::fmt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModelProviderError {
    ConfigurationMissing,
    InvalidRequest(String),
    InvalidResponse(String),
    ContextOverflow(String),
    AuthFailed(String),
    Config(ProviderConfigError),
    ModelNotRegistered {
        provider: ProviderId,
        model: ModelId,
    },
    Api(ApiError),
    Credential(String),
    Cancelled(String),
    Tokenization(String),
    Unavailable(String),
}

impl fmt::Display for ModelProviderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ConfigurationMissing => {
                formatter.write_str("model or provider is not configured")
            }
            Self::InvalidRequest(message) => write!(formatter, "invalid model request: {message}"),
            Self::InvalidResponse(message) => {
                write!(formatter, "invalid model response: {message}")
            }
            Self::ContextOverflow(message) => {
                write!(formatter, "model context window exceeded: {message}")
            }
            Self::AuthFailed(message) => {
                write!(formatter, "model provider authentication failed: {message}")
            }
            Self::Config(error) => error.fmt(formatter),
            Self::ModelNotRegistered { provider, model } => write!(
                formatter,
                "model '{model}' is not registered under provider '{provider}'"
            ),
            Self::Api(error) => error.fmt(formatter),
            Self::Credential(message) => {
                write!(formatter, "provider credential unavailable: {message}")
            }
            Self::Cancelled(message) => write!(formatter, "model invocation cancelled: {message}"),
            Self::Tokenization(message) => {
                write!(formatter, "local tokenization failed: {message}")
            }
            Self::Unavailable(message) => formatter.write_str(message),
        }
    }
}

impl From<SecretStoreError> for ModelProviderError {
    fn from(error: SecretStoreError) -> Self {
        Self::Credential(error.to_string())
    }
}

impl std::error::Error for ModelProviderError {}

impl From<ProviderConfigError> for ModelProviderError {
    fn from(error: ProviderConfigError) -> Self {
        Self::Config(error)
    }
}

impl From<ApiError> for ModelProviderError {
    fn from(error: ApiError) -> Self {
        match error {
            ApiError::InvalidRequest(message) => Self::InvalidRequest(message),
            ApiError::InvalidResponse(message) => Self::InvalidResponse(message),
            ApiError::ContextOverflow(message) => Self::ContextOverflow(message),
            ApiError::AuthFailed(message) => Self::AuthFailed(message),
            ApiError::UsageLimited => Self::Api(ApiError::UsageLimited),
            ApiError::Cancelled(message) => Self::Cancelled(message),
            error => Self::Api(error),
        }
    }
}

impl From<ash_model_tokenizer::LocalTokenizerError> for ModelProviderError {
    fn from(error: ash_model_tokenizer::LocalTokenizerError) -> Self {
        Self::Tokenization(error.to_string())
    }
}

impl ModelProviderError {
    pub fn is_transient(&self) -> bool {
        matches!(
            self,
            Self::Api(ApiError::Transport(_))
                | Self::Api(ApiError::RateLimited { .. })
                | Self::Api(ApiError::Overloaded)
                | Self::Api(ApiError::HttpStatus(500..=599))
        )
    }

    /// Returns the server-requested deadline for a transient rate limit.
    pub fn retry_after_deadline(&self) -> Option<std::time::Instant> {
        match self {
            Self::Api(ApiError::RateLimited {
                retry_at: Some(deadline),
            }) => Some(*deadline),
            _ => None,
        }
    }
}
