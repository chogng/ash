use super::AppServer;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::provider::ProviderApiKeyPolicyDto;
use ash_app_server_protocol::protocol::provider::ProviderApiKeyRemoveParams;
use ash_app_server_protocol::protocol::provider::ProviderApiKeySetParams;
use ash_app_server_protocol::protocol::provider::ProviderApiKeySetResult;
use ash_app_server_protocol::protocol::provider::ProviderCatalogEntryDto;
use ash_app_server_protocol::protocol::provider::ProviderListResult;
use ash_model_provider::ProviderCredentialError;
use ash_protocol::ModelConnectionId;
use model_provider_info::ApiKeyPolicy;
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
            .with_configs(config.values.connections.values())
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
        let config = self
            .config
            .as_ref()
            .ok_or_else(provider_credentials_unavailable)?
            .read_snapshot()
            .map_err(|_| provider_credentials_unavailable())?;
        let accounts = self
            .login
            .as_ref()
            .map(|login| login.refresh())
            .transpose()
            .map_err(|_| provider_credentials_unavailable())?;
        let mut providers: Vec<ProviderCatalogEntryDto> = self
            .configured_credentials()?
            .catalog()
            .map_err(provider_credential_error)?
            .into_iter()
            .map(|entry| {
                let oauth = matches!(
                    entry.connection.as_str(),
                    "chatgpt-subscription"
                        | "chatgpt-plan"
                        | "kimi-subscription"
                        | "xai-subscription"
                        | "bigmodel-coding-plan"
                        | "zai-coding-plan"
                        | "bigmodel-start-plan"
                        | "zai-start-plan"
                );
                let external = matches!(entry.connection.as_str(), "kimi-desktop" | "kimi-cli");
                let ready = if entry.connection.as_str() == "kimi-desktop" {
                    self.provider_runtime
                        .as_ref()
                        .is_some_and(|runtime| runtime.kimi_desktop_ready())
                } else if entry.connection.as_str() == "kimi-cli" {
                    self.provider_runtime
                        .as_ref()
                        .is_some_and(|runtime| runtime.kimi_cli_ready())
                } else if oauth {
                    accounts.as_ref().is_some_and(|state| {
                        state.accounts.iter().any(|account| {
                            account.account.provider == entry.connection.as_str()
                                && account.status == ash_login::AccountStatus::Ready
                        })
                    })
                } else {
                    entry.api_key_configured || entry.api_key_policy != ApiKeyPolicy::Required
                };
                ProviderCatalogEntryDto {
                    active: false,
                    configured: config.values.connections.contains_key(&entry.connection)
                        || ((oauth || external) && ready),
                    ready,
                    access: match entry.access_mode {
                        model_provider_info::ProviderAccessMode::Api => {
                            ash_protocol::ModelAccess::ApiKey
                        }
                        model_provider_info::ProviderAccessMode::Subscription => {
                            ash_protocol::ModelAccess::Subscription
                        }
                    },
                    connection: entry.connection.to_string(),
                    provider: entry.provider.to_string(),
                    display_name: entry.display_name,
                    api_key_policy: api_key_policy_dto(entry.api_key_policy),
                    api_key_configured: entry.api_key_configured,
                }
            })
            .collect();
        let mut preferred = std::collections::BTreeMap::new();
        for entry in providers.iter().filter(|entry| entry.ready) {
            let rank = model_provider_info::connection_priority(
                &ModelConnectionId::new(entry.connection.clone()).expect("catalog connection ID"),
            );
            let current = preferred
                .entry(entry.provider.clone())
                .or_insert((rank, entry.connection.clone()));
            if rank < current.0 {
                *current = (rank, entry.connection.clone());
            }
        }
        for entry in &mut providers {
            entry.active = preferred
                .get(&entry.provider)
                .is_some_and(|(_, connection)| connection == &entry.connection);
        }
        result(&ProviderListResult { providers })
    }

    pub(super) fn provider_api_key_remove(&self, params: Value) -> Result<Value, RpcError> {
        let params: ProviderApiKeyRemoveParams = decode(&params)?;
        let connection = ModelConnectionId::new(params.connection)
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        self.configured_credentials()?
            .remove_api_key(&connection)
            .map_err(provider_credential_error)?;
        self.updates
            .publish_provider_api_key_changed(ProviderApiKeySetResult {
                connection: connection.to_string(),
                api_key_configured: false,
            });
        result(&ProviderApiKeySetResult {
            connection: connection.to_string(),
            api_key_configured: false,
        })
    }

    pub(super) fn provider_api_key_set(&self, params: Value) -> Result<Value, RpcError> {
        let params: ProviderApiKeySetParams = decode(&params)?;
        let connection = ModelConnectionId::new(params.connection)
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let store = self
            .config
            .as_ref()
            .ok_or_else(provider_credentials_unavailable)?;
        let snapshot = store
            .read_snapshot()
            .map_err(|_| provider_credentials_unavailable())?;
        let config = snapshot
            .values
            .connections
            .get(&connection)
            .cloned()
            .unwrap_or_else(|| {
                model_provider_info::ModelProviderConfig::for_connection(connection.clone())
            });
        config
            .validate_static()
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        self.configured_credentials()?
            .set_api_key(&connection, params.api_key.into_bytes())
            .map_err(provider_credential_error)?;
        self.updates
            .publish_provider_api_key_changed(ProviderApiKeySetResult {
                connection: connection.to_string(),
                api_key_configured: true,
            });
        // Saving a credential does not choose the request route. Each model binding reads the
        // available connections and applies the subscription-first policy.
        store
            .apply(ash_config::ConfigCommandRequest {
                command_id: ash_protocol::CommandId::new(format!(
                    "connect-{connection}-{}",
                    snapshot.revision.get()
                ))
                .expect("generated command ID"),
                expected_revision: snapshot.revision,
                command: ash_config::UserConfigCommand::SaveConnection {
                    connection: connection.clone(),
                    config,
                },
            })
            .map_err(super::config_operations::config_operation_error)?;
        result(&ProviderApiKeySetResult {
            connection: connection.to_string(),
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
