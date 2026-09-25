use std::fmt;
use std::sync::Arc;

use ash_http_client::HttpHeader;
use ash_model_provider_config::ApiKeyHeader;
use ash_model_provider_config::ApiKeyPolicy;
use ash_model_provider_config::ProviderConfigRegistry;
use ash_model_provider_config::ProviderDefinition;
use ash_model_provider_config::ProviderId;
use ash_secrets::SecretKey;
use ash_secrets::SecretStore;
use ash_secrets::SecretStoreError;
use ash_secrets::SecretValue;

const MAX_API_KEY_BYTES: usize = 16 * 1024;

pub fn provider_api_key_secret_key(provider: &ProviderId) -> SecretKey {
    SecretKey::new(format!("provider/{provider}/default/api-key"))
        .expect("validated provider IDs produce valid secret keys")
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderCredentialStatus {
    pub provider: ProviderId,
    pub display_name: String,
    pub api_key_policy: ApiKeyPolicy,
    pub api_key_configured: bool,
}

/// One credential read materialized separately for generation and preflight protocols.
pub(crate) struct ModelHeaders {
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
        configs: impl IntoIterator<Item = &'a ash_model_provider_config::ModelProviderConfig>,
    ) -> Result<Self, ash_model_provider_config::ProviderConfigError> {
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
            .providers()
            .map(|definition| {
                let api_key_configured = match definition.api_key_policy {
                    ApiKeyPolicy::Unsupported => false,
                    ApiKeyPolicy::Optional | ApiKeyPolicy::Required => self
                        .secrets
                        .load(&provider_api_key_secret_key(&definition.id))?
                        .is_some(),
                };
                Ok(ProviderCredentialStatus {
                    provider: definition.id.clone(),
                    display_name: definition.name.clone(),
                    api_key_policy: definition.api_key_policy,
                    api_key_configured,
                })
            })
            .collect()
    }

    pub fn set_api_key(
        &self,
        provider: &ProviderId,
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
    pub fn remove_api_key(&self, provider: &ProviderId) -> Result<(), ProviderCredentialError> {
        self.secrets
            .delete(&provider_api_key_secret_key(provider))?;
        Ok(())
    }

    pub(crate) fn request_headers(
        &self,
        provider: &ProviderId,
    ) -> Result<Vec<HttpHeader>, ProviderCredentialError> {
        let definition = self.definition(provider)?;
        let secret = self.api_key(definition)?;
        encode_key(provider, definition.api_key_header, secret.as_ref())
    }

    /// Loads the stored API key for scope identity without the Required-policy missing-key error.
    pub(crate) fn stored_api_key(
        &self,
        provider: &ProviderId,
    ) -> Result<Option<SecretValue>, ProviderCredentialError> {
        let definition = self.definition(provider)?;
        if definition.api_key_policy == ApiKeyPolicy::Unsupported {
            return Ok(None);
        }
        Ok(self.secrets.load(&provider_api_key_secret_key(provider))?)
    }

    pub(crate) fn request_model_headers(
        &self,
        config: &ash_model_provider_config::NormalizedModelProviderConfig,
    ) -> Result<ModelHeaders, ProviderCredentialError> {
        let definition = self.definition(&config.provider)?;
        let secret = self.api_key(definition)?;
        let count_header = match config.input_token_count.as_ref().map(|count| count.profile) {
            Some(ash_model_provider_config::InputTokenCountProfile::GoogleGenerateContent) => {
                ApiKeyHeader::XGoogApiKey
            }
            Some(ash_model_provider_config::InputTokenCountProfile::AnthropicMessages) => {
                ApiKeyHeader::XApiKey
            }
            Some(
                ash_model_provider_config::InputTokenCountProfile::OpenAiResponses
                | ash_model_provider_config::InputTokenCountProfile::KimiChatCompletions
                | ash_model_provider_config::InputTokenCountProfile::ZaiChatCompletions,
            ) => ApiKeyHeader::Bearer,
            None => definition.api_key_header,
        };
        Ok(ModelHeaders {
            invocation: encode_key(&config.provider, definition.api_key_header, secret.as_ref())?,
            measurement: encode_key(&config.provider, count_header, secret.as_ref())?,
        })
    }

    fn api_key(
        &self,
        definition: &ProviderDefinition,
    ) -> Result<Option<SecretValue>, ProviderCredentialError> {
        if definition.api_key_policy == ApiKeyPolicy::Unsupported {
            return Ok(None);
        }
        let secret = self
            .secrets
            .load(&provider_api_key_secret_key(&definition.id))?;
        if let Some(secret) = &secret {
            validate_api_key(secret.expose())?;
        } else if definition.api_key_policy == ApiKeyPolicy::Required {
            return Err(ProviderCredentialError::ApiKeyMissing(
                definition.id.clone(),
            ));
        }
        Ok(secret)
    }

    fn definition(
        &self,
        provider: &ProviderId,
    ) -> Result<&ProviderDefinition, ProviderCredentialError> {
        self.providers
            .get(provider)
            .ok_or(ProviderCredentialError::UnknownProvider)
    }
}

fn encode_key(
    provider: &ProviderId,
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
    ApiKeyMissing(ProviderId),
    InvalidStoredApiKey(ProviderId),
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
