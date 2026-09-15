use super::AppServer;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::provider::ProviderApiKeyPolicyDto;
use ash_app_server_protocol::protocol::provider::ProviderApiKeySetParams;
use ash_app_server_protocol::protocol::provider::ProviderApiKeySetResult;
use ash_app_server_protocol::protocol::provider::ProviderCatalogEntryDto;
use ash_app_server_protocol::protocol::provider::ProviderListResult;
use ash_model_provider::ProviderCredentialError;
use ash_model_provider_config::ApiKeyPolicy;
use ash_model_provider_config::ProviderId;
use serde_json::Value;

impl AppServer {
    pub(super) fn configured_credentials(
        &self,
    ) -> Result<ash_model_provider::ProviderCredentialService, RpcError> {
        let credentials = self
            .provider_credentials
            .as_ref()
            .ok_or_else(provider_credentials_unavailable)?;
        let Some(store) = &self.config else {
            return Ok(credentials.as_ref().clone());
        };
        let config = store
            .read_snapshot()
            .map_err(|_| provider_credentials_unavailable())?;
        credentials
            .with_configs(config.values.providers.values())
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))
    }
    pub(super) fn provider_probe(&self, params: Value) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::provider::ProviderProbeParams;
        use ash_app_server_protocol::protocol::provider::ProviderProbeResult;
        let params: ProviderProbeParams = decode(&params)?;
        let config = super::config_operations::provider_config_from_dto(params.config)?;
        let runtime = self
            .provider_runtime
            .as_ref()
            .ok_or_else(provider_credentials_unavailable)?;
        let response = match runtime.probe_connection(
            &config,
            params.api_key.map(|key| key.into_bytes()),
            params.model.as_deref(),
        ) {
            Ok(None) => ProviderProbeResult::Passed,
            Ok(Some(models)) => ProviderProbeResult::Models { models },
            Err(error) => ProviderProbeResult::Failed {
                message: probe_error(error),
            },
        };
        result(&response)
    }

    pub(super) fn provider_list(&self) -> Result<Value, RpcError> {
        let providers = self
            .configured_credentials()?
            .catalog()
            .map_err(provider_credential_error)?;
        let providers = providers
            .into_iter()
            .map(|provider| ProviderCatalogEntryDto {
                provider: provider.provider.to_string(),
                display_name: provider.display_name,
                api_key_policy: api_key_policy_dto(provider.api_key_policy),
                api_key_configured: provider.api_key_configured,
            })
            .collect();
        result(&ProviderListResult { providers })
    }

    pub(super) fn provider_api_key_set(&self, params: Value) -> Result<Value, RpcError> {
        let params: ProviderApiKeySetParams = decode(&params)?;
        let provider = ProviderId::new(params.provider)
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        self.configured_credentials()?
            .set_api_key(&provider, params.api_key.into_bytes())
            .map_err(provider_credential_error)?;
        result(&ProviderApiKeySetResult {
            provider: provider.to_string(),
            api_key_configured: true,
        })
    }
}

fn provider_credentials_unavailable() -> RpcError {
    RpcError::new(-32093, AppServerErrorName::ProviderCredentialsUnavailable)
}

fn provider_credential_error(error: ProviderCredentialError) -> RpcError {
    match error {
        ProviderCredentialError::UnknownProvider
        | ProviderCredentialError::ApiKeyUnsupported
        | ProviderCredentialError::InvalidApiKey => {
            RpcError::new(-32602, AppServerErrorName::InvalidParams)
        }
        ProviderCredentialError::SecretStore(_) => RpcError::new(
            -32094,
            AppServerErrorName::ProviderCredentialOperationFailed,
        ),
        ProviderCredentialError::ApiKeyMissing(_)
        | ProviderCredentialError::InvalidStoredApiKey(_) => RpcError::new(
            -32094,
            AppServerErrorName::ProviderCredentialOperationFailed,
        ),
    }
}

fn api_key_policy_dto(policy: ApiKeyPolicy) -> ProviderApiKeyPolicyDto {
    match policy {
        ApiKeyPolicy::Unsupported => ProviderApiKeyPolicyDto::Unsupported,
        ApiKeyPolicy::Optional => ProviderApiKeyPolicyDto::Optional,
        ApiKeyPolicy::Required => ProviderApiKeyPolicyDto::Required,
    }
}

fn probe_error(error: ash_model_provider::ModelProviderError) -> String {
    use ash_model_provider::ModelProviderError;
    match error {
        ModelProviderError::AuthFailed(_) | ModelProviderError::Credential(_) => {
            "Authentication failed · Check the API key".into()
        }
        ModelProviderError::Api(ash_model_provider::ApiError::HttpStatus(401 | 403)) => {
            "Authentication failed · Check the API key and model access".into()
        }
        ModelProviderError::Api(ash_model_provider::ApiError::HttpStatus(status)) => {
            format!("Endpoint returned HTTP {status} · Check the URL, API type and model ID")
        }
        ModelProviderError::InvalidResponse(_) => {
            "Endpoint returned an invalid response · Check the API type".into()
        }
        ModelProviderError::InvalidRequest(_) | ModelProviderError::Config(_) => {
            "Invalid connection settings · Check the URL and model ID".into()
        }
        _ => "Endpoint test failed · Check the connection, API type and model availability".into(),
    }
}
