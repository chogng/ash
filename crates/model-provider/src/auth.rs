use std::fmt;
use std::sync::Arc;

use ash_http_client::HttpHeader;
use ash_protocol::ModelConnectionId;
use ash_secrets::SecretKey;
use ash_secrets::SecretStore;
use ash_secrets::SecretStoreError;
use ash_secrets::SecretValue;
use model_provider_info::ApiKeyHeader;
use model_provider_info::ApiKeyPolicy;
use model_provider_info::ProviderConfigRegistry;
use model_provider_info::ProviderDefinition;
use model_provider_info::ProviderId;

const MAX_API_KEY_BYTES: usize = 16 * 1024;

pub fn provider_api_key_secret_key(provider: &ModelConnectionId) -> SecretKey {
    SecretKey::new(format!("provider/{provider}/default/api-key"))
        .expect("validated provider IDs produce valid secret keys")
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderCredentialStatus {
    pub provider: ProviderId,
    pub connection: ModelConnectionId,
    pub access_mode: model_provider_info::ProviderAccessMode,
    pub display_name: String,
    pub api_key_policy: ApiKeyPolicy,
    pub api_key_configured: bool,
}

/// Authentication resolved from one direct-provider credential read.
#[derive(Default)]
pub(crate) struct RequestAuthentication {
    pub(crate) identity: ash_client::RequestIdentity,
    pub(crate) headers: Vec<HttpHeader>,
}

impl RequestAuthentication {
    pub(crate) fn into_target(self, base_url: impl Into<String>) -> ash_client::ResolvedApiTarget {
        ash_client::ResolvedApiTarget::new(
            base_url,
            self.headers,
            ash_client::RequestBinding::new(ash_client::RequestPurpose::Model, self.identity),
        )
    }
}

/// One snapshot encoded separately for generation and preflight protocols.
pub(crate) struct ModelHeaders {
    pub(crate) identity: ash_client::RequestIdentity,
    pub(crate) invocation: Vec<HttpHeader>,
    pub(crate) measurement: Vec<HttpHeader>,
}

/// Owns provider-scoped API-key persistence and direct-request authentication.
///
/// App Server adapters use this service to mutate credentials, while model runtimes use the same
/// service to resolve request headers. Callers never receive stored secret values.
#[derive(Clone)]
pub struct ProviderCredentialService {
    providers: ProviderConfigRegistry,
    secrets: Arc<dyn SecretStore>,
}

impl ProviderCredentialService {
    /// Resolves credentials against the persisted connection definitions.
    pub fn with_configs<'a>(
        &self,
        configs: impl IntoIterator<Item = &'a model_provider_info::ModelProviderConfig>,
    ) -> Result<Self, model_provider_info::ProviderConfigError> {
        Ok(self.with_registry(self.providers.with_configs(configs)?))
    }
    /// Uses a validated connection snapshot while preserving the same secret authority.
    pub fn with_registry(&self, providers: ProviderConfigRegistry) -> Self {
        Self::new(providers, Arc::clone(&self.secrets))
    }
    pub fn new(providers: ProviderConfigRegistry, secrets: Arc<dyn SecretStore>) -> Self {
        Self { providers, secrets }
    }

    pub fn catalog(&self) -> Result<Vec<ProviderCredentialStatus>, ProviderCredentialError> {
        self.providers
            .connections()
            .into_iter()
            .map(|connection| {
                let definition = &connection.transport;
                let api_key_configured = match definition.api_key_policy {
                    ApiKeyPolicy::Unsupported => false,
                    ApiKeyPolicy::Optional | ApiKeyPolicy::Required => self
                        .secrets
                        .load(&provider_api_key_secret_key(&connection.id))?
                        .is_some(),
                };
                Ok(ProviderCredentialStatus {
                    provider: connection.provider,
                    connection: connection.id,
                    access_mode: connection.access_mode,
                    display_name: definition.name.clone(),
                    api_key_policy: definition.api_key_policy,
                    api_key_configured,
                })
            })
            .collect()
    }

    pub fn set_api_key(
        &self,
        provider: &ModelConnectionId,
        api_key: Vec<u8>,
    ) -> Result<(), ProviderCredentialError> {
        let definition = self.definition(provider)?;
        if definition.api_key_policy == ApiKeyPolicy::Unsupported {
            return Err(ProviderCredentialError::ApiKeyUnsupported);
        }
        validate_api_key(&api_key)?;
        self.secrets.store(
            &provider_api_key_secret_key(provider),
            &SecretValue::new(api_key),
        )?;
        Ok(())
    }

    /// Deletes a removed connection's credential without requiring it to remain in the registry.
    pub fn remove_api_key(
        &self,
        provider: &ModelConnectionId,
    ) -> Result<(), ProviderCredentialError> {
        self.secrets
            .delete(&provider_api_key_secret_key(provider))?;
        Ok(())
    }

    pub(crate) fn request_authentication(
        &self,
        provider: &ModelConnectionId,
    ) -> Result<RequestAuthentication, ProviderCredentialError> {
        let definition = self.definition(provider)?;
        let secret = self.api_key(provider, &definition)?;
        Ok(RequestAuthentication {
            identity: credential_identity(provider, secret.as_ref()),
            headers: encode_key(provider, definition.api_key_header, secret.as_ref())?,
        })
    }

    pub(crate) fn request_model_headers(
        &self,
        config: &model_provider_info::NormalizedModelProviderConfig,
    ) -> Result<ModelHeaders, ProviderCredentialError> {
        let definition = self.definition(&config.connection)?;
        let secret = self.api_key(&config.connection, &definition)?;
        let count_header = match config.input_token_count.as_ref().map(|count| count.profile) {
            Some(model_provider_info::InputTokenCountProfile::GoogleGenerateContent) => {
                ApiKeyHeader::XGoogApiKey
            }
            Some(model_provider_info::InputTokenCountProfile::AnthropicMessages) => {
                ApiKeyHeader::XApiKey
            }
            Some(
                model_provider_info::InputTokenCountProfile::OpenAiResponses
                | model_provider_info::InputTokenCountProfile::KimiChatCompletions
                | model_provider_info::InputTokenCountProfile::ZaiChatCompletions,
            ) => ApiKeyHeader::Bearer,
            None => definition.api_key_header,
        };
        Ok(ModelHeaders {
            identity: credential_identity(&config.connection, secret.as_ref()),
            invocation: encode_key(
                &config.connection,
                definition.api_key_header,
                secret.as_ref(),
            )?,
            measurement: encode_key(&config.connection, count_header, secret.as_ref())?,
        })
    }

    fn api_key(
        &self,
        connection: &ModelConnectionId,
        definition: &ProviderDefinition,
    ) -> Result<Option<SecretValue>, ProviderCredentialError> {
        if definition.api_key_policy == ApiKeyPolicy::Unsupported {
            return Ok(None);
        }
        let secret = self
            .secrets
            .load(&provider_api_key_secret_key(connection))?;
        if let Some(secret) = &secret {
            validate_api_key(secret.expose())?;
        } else if definition.api_key_policy == ApiKeyPolicy::Required {
            return Err(ProviderCredentialError::ApiKeyMissing(connection.clone()));
        }
        Ok(secret)
    }

    fn definition(
        &self,
        provider: &ModelConnectionId,
    ) -> Result<ProviderDefinition, ProviderCredentialError> {
        self.providers
            .connection(provider)
            .map(|connection| connection.transport)
            .ok_or(ProviderCredentialError::UnknownProvider)
    }
}

fn encode_key(
    provider: &ModelConnectionId,
    format: ApiKeyHeader,
    secret: Option<&SecretValue>,
) -> Result<Vec<HttpHeader>, ProviderCredentialError> {
    let Some(secret) = secret else {
        return Ok(Vec::new());
    };
    let value = std::str::from_utf8(secret.expose())
        .map_err(|_| ProviderCredentialError::InvalidStoredApiKey(provider.clone()))?;
    Ok(vec![match format {
        ApiKeyHeader::Bearer => HttpHeader::new("Authorization", format!("Bearer {value}")),
        ApiKeyHeader::XApiKey => HttpHeader::new("x-api-key", value),
        ApiKeyHeader::XGoogApiKey => HttpHeader::new("x-goog-api-key", value),
    }])
}

#[derive(Debug)]
pub enum ProviderCredentialError {
    UnknownProvider,
    ApiKeyUnsupported,
    InvalidApiKey,
    ApiKeyMissing(ModelConnectionId),
    InvalidStoredApiKey(ModelConnectionId),
    SecretStore(SecretStoreError),
}

impl fmt::Display for ProviderCredentialError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownProvider => formatter.write_str("unknown model provider"),
            Self::ApiKeyUnsupported => formatter.write_str("provider does not accept an API key"),
            Self::InvalidApiKey => formatter.write_str("API key is invalid"),
            Self::ApiKeyMissing(provider) => {
                write!(formatter, "no API key is stored for provider '{provider}'")
            }
            Self::InvalidStoredApiKey(provider) => {
                write!(
                    formatter,
                    "stored API key for provider '{provider}' is invalid"
                )
            }
            Self::SecretStore(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for ProviderCredentialError {}

impl From<SecretStoreError> for ProviderCredentialError {
    fn from(error: SecretStoreError) -> Self {
        Self::SecretStore(error)
    }
}

fn validate_api_key(api_key: &[u8]) -> Result<(), ProviderCredentialError> {
    if api_key.is_empty()
        || api_key.len() > MAX_API_KEY_BYTES
        || api_key.iter().any(|byte| byte.is_ascii_control())
    {
        return Err(ProviderCredentialError::InvalidApiKey);
    }
    Ok(())
}

fn credential_identity(
    connection: &ModelConnectionId,
    secret: Option<&SecretValue>,
) -> ash_client::RequestIdentity {
    match secret {
        Some(secret) => {
            ash_client::RequestIdentity::connection(connection.as_str(), secret.expose())
        }
        None => ash_client::RequestIdentity::Anonymous,
    }
}
