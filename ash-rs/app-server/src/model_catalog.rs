use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
use ash_protocol::ModelRef;
use core_api::CoreError;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ModelCatalogRefreshError {
    Authentication,
    Permission,
    Unsupported,
    RateLimited,
    Unreachable,
    ProviderUnavailable,
    InvalidRequest,
    InvalidResponse,
    InvalidConfiguration,
    Cancelled,
    Unknown,
}

impl From<ash_models_manager::ModelsManagerError> for ModelCatalogRefreshError {
    fn from(error: ash_models_manager::ModelsManagerError) -> Self {
        use ash_models_manager::CatalogSourceErrorKind;
        use ash_models_manager::ModelsManagerError;
        match error {
            ModelsManagerError::Source { error, .. } => match error.kind() {
                CatalogSourceErrorKind::Authentication => Self::Authentication,
                CatalogSourceErrorKind::Permission => Self::Permission,
                CatalogSourceErrorKind::Unsupported => Self::Unsupported,
                CatalogSourceErrorKind::RateLimited => Self::RateLimited,
                CatalogSourceErrorKind::Unreachable => Self::Unreachable,
                CatalogSourceErrorKind::ProviderUnavailable => Self::ProviderUnavailable,
                CatalogSourceErrorKind::InvalidRequest => Self::InvalidRequest,
                CatalogSourceErrorKind::InvalidPayload => Self::InvalidResponse,
                CatalogSourceErrorKind::Cancelled => Self::Cancelled,
                CatalogSourceErrorKind::Transient => Self::Unknown,
            },
            ModelsManagerError::UnknownProvider(_) => Self::InvalidConfiguration,
            ModelsManagerError::DynamicSourceRequired(_) => Self::Unsupported,
            ModelsManagerError::ScopeMismatch { .. }
            | ModelsManagerError::DuplicateDiscoveredModel { .. }
            | ModelsManagerError::NotModifiedWithoutObservation(_) => Self::InvalidResponse,
            _ => Self::Unknown,
        }
    }
}

/// Supplies the product model catalog and configured default.
///
/// Catalog membership is presentation metadata, not evidence that a remote invocation will succeed.
/// Runtime configuration, authentication, entitlement, rate limits, and transport are checked by the
/// selected Turn backend and become errors on that Turn.
pub(crate) trait ModelCatalog: Send + Sync {
    fn refresh(
        &self,
        _provider: &ash_protocol::ProviderId,
    ) -> Result<Vec<ModelCatalogEntry>, ModelCatalogRefreshError> {
        Err(ModelCatalogRefreshError::Unsupported)
    }
    fn list(&self) -> Result<Vec<ModelCatalogEntry>, CoreError>;
    fn configured_default(&self) -> Result<Option<ModelRef>, CoreError>;
}

pub(crate) struct UnavailableModelCatalog;

impl ModelCatalog for UnavailableModelCatalog {
    fn list(&self) -> Result<Vec<ModelCatalogEntry>, CoreError> {
        Ok(Vec::new())
    }

    fn configured_default(&self) -> Result<Option<ModelRef>, CoreError> {
        Ok(None)
    }
}

pub(crate) fn unavailable_model_catalog() -> Arc<dyn ModelCatalog> {
    Arc::new(UnavailableModelCatalog)
}
