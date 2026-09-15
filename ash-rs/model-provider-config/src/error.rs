use ash_protocol::{ModelId, ProviderId};
use std::fmt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderConfigError {
    DuplicateProvider(ProviderId),
    UnknownProvider(ProviderId),
    InvalidProvider {
        provider: ProviderId,
        message: String,
    },
    MissingBaseUrl(ProviderId),
    InvalidBaseUrl {
        provider: ProviderId,
        base_url: String,
    },
    InvalidMaxOutputTokens(ProviderId),
    InvalidModelContext {
        provider: ProviderId,
        model: ModelId,
    },
    ModelNotRegistered {
        provider: ProviderId,
        model: ModelId,
    },
    ProviderMismatch {
        configured: ProviderId,
        selected: ProviderId,
    },
}

impl fmt::Display for ProviderConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateProvider(provider) => {
                write!(formatter, "provider '{provider}' is already registered")
            }
            Self::UnknownProvider(provider) => {
                write!(formatter, "provider '{provider}' is not registered")
            }
            Self::InvalidProvider { provider, message } => {
                write!(formatter, "provider '{provider}' is invalid: {message}")
            }
            Self::MissingBaseUrl(provider) => {
                write!(formatter, "provider '{provider}' requires a base URL")
            }
            Self::InvalidBaseUrl { provider, base_url } => write!(
                formatter,
                "provider '{provider}' base URL must be a valid HTTP or HTTPS URL: '{base_url}'"
            ),
            Self::InvalidMaxOutputTokens(provider) => write!(
                formatter,
                "provider '{provider}' max output tokens must be greater than zero"
            ),
            Self::InvalidModelContext { provider, model } => write!(
                formatter,
                "model '{model}' for provider '{provider}' must have a positive context window and automatic compaction limit"
            ),
            Self::ModelNotRegistered { provider, model } => write!(
                formatter,
                "model '{model}' is not registered for provider '{provider}'"
            ),
            Self::ProviderMismatch {
                configured,
                selected,
            } => write!(
                formatter,
                "configured provider '{configured}' does not match selected provider '{selected}'"
            ),
        }
    }
}

impl std::error::Error for ProviderConfigError {}
