use super::RpcError;
use super::core_error;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::model::ModelListParams;
use ash_app_server_protocol::protocol::model::ModelPreferencesUpdateParams;
use ash_app_server_protocol::protocol::provider::ProviderModelsListFailureCodeDto;
use ash_app_server_protocol::protocol::provider::ProviderModelsListFailureDto;
use ash_app_server_protocol::protocol::provider::ProviderModelsListResult;
use serde_json::Value;

/// Borrows only the services needed by this protocol domain.
pub(super) struct ModelRequestProcessor<'a> {
    model_catalog: &'a std::sync::Arc<dyn crate::model_catalog::ModelCatalog>,
    secret_processor: &'a super::secret_operations::SecretRequestProcessor,
}

impl<'a> ModelRequestProcessor<'a> {
    pub(super) fn new(
        model_catalog: &'a std::sync::Arc<dyn crate::model_catalog::ModelCatalog>,
        secret_processor: &'a super::secret_operations::SecretRequestProcessor,
    ) -> Self {
        Self {
            model_catalog,
            secret_processor,
        }
    }
    pub(super) fn model_list(&self, params: &Value) -> Result<Value, RpcError> {
        let _: ModelListParams = decode(params)?;
        // The catalog resolves connection readiness from credentials. Preserve a typed storage
        // failure before that domain resolution turns it into a general model error.
        self.secret_processor.check_availability()?;
        result(&self.model_catalog.catalog_snapshot().map_err(core_error)?)
    }
    pub(super) fn model_preferences_update(&self, params: &Value) -> Result<Value, RpcError> {
        use crate::model_catalog::ModelPreferencesCommand;
        use crate::model_catalog::ModelPreferencesError;
        let params: ModelPreferencesUpdateParams = decode(params)?;
        let outcome = self
            .model_catalog
            .set_preferences(ModelPreferencesCommand {
                command_id: params.command_id,
                expected_revision: ash_config::ConfigRevision::new(params.expected_revision),
                model: params.model,
                update: ash_models_manager::ModelPreferencesUpdate {
                    acceleration: params.acceleration,
                    long_context: params.long_context,
                },
            })
            .map_err(|error| match error {
                ModelPreferencesError::Catalog(error) => core_error(error),
                ModelPreferencesError::InvalidPreferences(error) => RpcError {
                    detail: Some(error.to_string()),
                    ..RpcError::new(-32602, AppServerErrorName::InvalidParams)
                },
                ModelPreferencesError::Configuration(error) => {
                    super::config_operations::config_operation_error(error)
                }
            })?;
        result(&super::config_operations::config_command_result(outcome))
    }
    pub(super) fn provider_models_list(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::provider::ProviderModelsListParams =
            decode(params)?;
        let provider = ash_protocol::ModelConnectionId::new(params.connection)
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let response = match self.model_catalog.refresh(&provider) {
            Ok(models) if models.is_empty() => ProviderModelsListResult::Empty,
            Ok(models) => ProviderModelsListResult::Models { models },
            Err(error) => ProviderModelsListResult::Failed {
                failure: ProviderModelsListFailureDto {
                    code: provider_models_failure_code(error),
                },
            },
        };
        result(&response)
    }
}

pub(super) fn provider_models_failure_code(
    error: crate::model_catalog::ModelCatalogRefreshError,
) -> ProviderModelsListFailureCodeDto {
    use crate::model_catalog::ModelCatalogRefreshError;
    match error {
        ModelCatalogRefreshError::Authentication => {
            ProviderModelsListFailureCodeDto::Authentication
        }
        ModelCatalogRefreshError::Permission => ProviderModelsListFailureCodeDto::Permission,
        ModelCatalogRefreshError::Unsupported => ProviderModelsListFailureCodeDto::Unsupported,
        ModelCatalogRefreshError::RateLimited => ProviderModelsListFailureCodeDto::RateLimited,
        ModelCatalogRefreshError::Unreachable => ProviderModelsListFailureCodeDto::Unreachable,
        ModelCatalogRefreshError::ProviderUnavailable => {
            ProviderModelsListFailureCodeDto::ProviderUnavailable
        }
        ModelCatalogRefreshError::InvalidRequest => {
            ProviderModelsListFailureCodeDto::InvalidRequest
        }
        ModelCatalogRefreshError::InvalidResponse => {
            ProviderModelsListFailureCodeDto::InvalidResponse
        }
        ModelCatalogRefreshError::InvalidConfiguration => {
            ProviderModelsListFailureCodeDto::InvalidConfiguration
        }
        ModelCatalogRefreshError::Cancelled => ProviderModelsListFailureCodeDto::Cancelled,
        ModelCatalogRefreshError::Unknown => ProviderModelsListFailureCodeDto::Unknown,
    }
}
