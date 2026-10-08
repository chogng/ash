use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
use ash_protocol::ModelAccess;
use ash_protocol::ModelRef;
use core_api::CoreError;
use std::sync::Arc;

pub(crate) struct ModelPreferencesCommand {
    pub command_id: ash_protocol::CommandId,
    pub expected_revision: ash_config::ConfigRevision,
    pub model: ModelRef,
    pub update: ash_models_manager::ModelPreferencesUpdate,
}

#[derive(Debug)]
pub(crate) enum ModelPreferencesError {
    Catalog(CoreError),
    InvalidPreferences(model_provider_info::ProviderConfigError),
    Configuration(ash_config::ConfigCommandError),
}

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
    /// Updates the active connection after validating the model's declared choices.
    fn set_preferences(
        &self,
        command: ModelPreferencesCommand,
    ) -> Result<ash_config::ConfigCommandResult, ModelPreferencesError>;
    fn refresh(
        &self,
        _connection: &ash_protocol::ModelConnectionId,
    ) -> Result<Vec<ModelCatalogEntry>, ModelCatalogRefreshError> {
        Err(ModelCatalogRefreshError::Unsupported)
    }
    fn list(&self) -> Result<Vec<ModelCatalogEntry>, CoreError>;

    /// Captures current credential scopes with their cached rows, without network discovery.
    fn catalog_snapshot(
        &self,
    ) -> Result<ash_app_server_protocol::protocol::model::ModelListResult, CoreError> {
        Ok(ash_app_server_protocol::protocol::model::ModelListResult {
            models: self.list()?,
            catalog_scopes: None,
        })
    }

    /// Reads an external connection's opaque cache identity without refreshing it.
    fn external_scope(
        &self,
        _connection: &ash_protocol::ModelConnectionId,
    ) -> Result<Option<String>, ModelCatalogRefreshError> {
        Ok(None)
    }
    /// Reads the current request path for a model; catalog metadata can differ from the active account.
    fn current_access(&self, model: &ModelRef) -> Result<ModelAccess, CoreError>;
    fn configured_default(&self) -> Result<Option<ModelRef>, CoreError>;
}

pub(crate) struct UnavailableModelCatalog;

impl ModelCatalog for UnavailableModelCatalog {
    fn set_preferences(
        &self,
        _: ModelPreferencesCommand,
    ) -> Result<ash_config::ConfigCommandResult, ModelPreferencesError> {
        Err(ModelPreferencesError::Catalog(CoreError::Model(
            "model catalog unavailable".to_owned(),
        )))
    }
    fn list(&self) -> Result<Vec<ModelCatalogEntry>, CoreError> {
        Ok(Vec::new())
    }

    fn current_access(&self, _: &ModelRef) -> Result<ModelAccess, CoreError> {
        Ok(ModelAccess::Unknown)
    }

    fn configured_default(&self) -> Result<Option<ModelRef>, CoreError> {
        Ok(None)
    }
}

pub(crate) fn unavailable_model_catalog() -> Arc<dyn ModelCatalog> {
    Arc::new(UnavailableModelCatalog)
}
