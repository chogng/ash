use crate::CatalogScopeKey;
use crate::CatalogSourceError;
use crate::ModelCapability;
use ash_protocol::ModelId;
use ash_protocol::ProviderId;
use std::fmt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModelsManagerError {
    UnknownProvider(ProviderId),
    ModelNotListed {
        provider: ProviderId,
        model: ModelId,
    },
    ModelUnavailable {
        provider: ProviderId,
        model: ModelId,
    },
    ModelRetired {
        provider: ProviderId,
        model: ModelId,
    },
    CapabilityUnsupported {
        provider: ProviderId,
        model: ModelId,
        capability: ModelCapability,
    },
    CapabilityUnknown {
        provider: ProviderId,
        model: ModelId,
        capability: ModelCapability,
    },
    DynamicSourceRequired(CatalogScopeKey),
    Source {
        scope: CatalogScopeKey,
        error: CatalogSourceError,
    },
    ScopeMismatch {
        requested: CatalogScopeKey,
        returned: CatalogScopeKey,
    },
    DuplicateDiscoveredModel {
        scope: CatalogScopeKey,
        model: ModelId,
    },
    NotModifiedWithoutObservation(CatalogScopeKey),
}

impl fmt::Display for ModelsManagerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownProvider(provider) => {
                write!(formatter, "unknown model provider '{provider}'")
            }
            Self::ModelNotListed { provider, model } => write!(
                formatter,
                "model '{model}' is not listed under provider '{provider}'"
            ),
            Self::ModelUnavailable { provider, model } => write!(
                formatter,
                "model '{model}' is unavailable under provider '{provider}'"
            ),
            Self::ModelRetired { provider, model } => write!(
                formatter,
                "model '{model}' is retired under provider '{provider}'"
            ),
            Self::CapabilityUnsupported {
                provider,
                model,
                capability,
            } => write!(
                formatter,
                "model '{provider}/{model}' does not support {capability}"
            ),
            Self::CapabilityUnknown {
                provider,
                model,
                capability,
            } => write!(
                formatter,
                "model '{provider}/{model}' has unknown support for {capability}"
            ),
            Self::DynamicSourceRequired(scope) => write!(
                formatter,
                "catalog scope '{}:{}' requires a dynamic source",
                scope.provider(),
                scope.source_scope()
            ),
            Self::Source { scope, error } => write!(
                formatter,
                "catalog refresh failed for '{}:{}': {error}",
                scope.provider(),
                scope.source_scope()
            ),
            Self::ScopeMismatch {
                requested,
                returned,
            } => write!(
                formatter,
                "catalog source returned scope '{}:{}' for requested scope '{}:{}'",
                returned.provider(),
                returned.source_scope(),
                requested.provider(),
                requested.source_scope()
            ),
            Self::DuplicateDiscoveredModel { scope, model } => write!(
                formatter,
                "catalog source returned duplicate model '{}' for '{}:{}'",
                model,
                scope.provider(),
                scope.source_scope()
            ),
            Self::NotModifiedWithoutObservation(scope) => write!(
                formatter,
                "catalog source returned not-modified before a live observation for '{}:{}'",
                scope.provider(),
                scope.source_scope()
            ),
        }
    }
}

impl std::error::Error for ModelsManagerError {}
