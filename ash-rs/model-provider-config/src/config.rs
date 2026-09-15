use crate::ApiProfile;
use crate::BaseUrlNormalization;
use crate::NormalizedInputTokenCountConfig;
use crate::ProviderConfigError;
use ash_protocol::ModelId;
use ash_protocol::ProviderId;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Model-specific context limits supplied by user or host configuration.
///
/// This metadata is deliberately separate from transport normalization: Core
/// consumes it to decide whether it can enforce a context budget itself.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelContextConfig {
    pub context_window: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_compact_token_limit: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProviderConfig {
    pub provider: ProviderId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom: Option<CustomProviderConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub model_context: BTreeMap<ModelId, ModelContextConfig>,
}

impl ModelProviderConfig {
    pub fn new(provider: ProviderId) -> Self {
        Self {
            provider,
            custom: None,
            base_url: None,
            max_output_tokens: None,
            model_context: BTreeMap::new(),
        }
    }

    pub fn validate_static(&self) -> Result<(), ProviderConfigError> {
        if let Some(custom) = &self.custom {
            custom.definition(self)?.validate()?;
        }
        if self.max_output_tokens == Some(0) {
            return Err(ProviderConfigError::InvalidMaxOutputTokens(
                self.provider.clone(),
            ));
        }
        for (model, context) in &self.model_context {
            if context.context_window == 0 || context.auto_compact_token_limit == Some(0) {
                return Err(ProviderConfigError::InvalidModelContext {
                    provider: self.provider.clone(),
                    model: model.clone(),
                });
            }
        }
        if let Some(base_url) = self.base_url.as_deref() {
            let base_url = base_url.trim();
            if !base_url.is_empty() && !is_http_url(base_url) {
                return Err(ProviderConfigError::InvalidBaseUrl {
                    provider: self.provider.clone(),
                    base_url: base_url.into(),
                });
            }
        }
        Ok(())
    }
}

/// User-defined API connection, independent of built-in provider identities.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomProviderConfig {
    #[serde(default = "default_custom_context_window")]
    pub context_window: u32,
    #[serde(default)]
    pub order: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelId>,
    pub name: String,
    pub protocol: CustomProviderProtocol,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CustomProviderProtocol {
    Responses,
    ChatCompletions,
    AnthropicMessages,
}

impl CustomProviderConfig {
    fn catalog_models(&self) -> Vec<crate::Model> {
        let registry = crate::ProviderConfigRegistry::builtin();
        let profile = match self.protocol {
            CustomProviderProtocol::Responses => ApiProfile::OpenAiResponses,
            CustomProviderProtocol::ChatCompletions => ApiProfile::OpenAiChatCompletions,
            CustomProviderProtocol::AnthropicMessages => ApiProfile::AnthropicMessages,
        };
        crate::STATIC_MODEL_CATALOG
            .iter()
            .filter(|entry| {
                entry.runtime == crate::StaticModelRuntime::ProviderApi
                    && match &self.model {
                        Some(id) => entry.model_id == id.as_str(),
                        None => registry
                            .get(&ProviderId::new(entry.provider_id).expect("static provider"))
                            .is_some_and(|provider| provider.api_profile == profile),
                    }
            })
            .map(|entry| (entry.model_id, entry.model()))
            .collect::<BTreeMap<_, _>>()
            .into_values()
            .collect()
    }

    pub(crate) fn definition(
        &self,
        config: &ModelProviderConfig,
    ) -> Result<crate::ProviderDefinition, ProviderConfigError> {
        if !config.provider.as_str().starts_with("custom-")
            && config.provider.as_str() != "openai-compatible"
        {
            return Err(ProviderConfigError::UnknownProvider(
                config.provider.clone(),
            ));
        }
        let base_url = config
            .base_url
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| ProviderConfigError::MissingBaseUrl(config.provider.clone()))?;
        let valid_url = url::Url::parse(base_url.trim()).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
        });
        if !valid_url {
            return Err(ProviderConfigError::InvalidBaseUrl {
                provider: config.provider.clone(),
                base_url: base_url.into(),
            });
        }
        if !matches!(self.context_window, 272_000 | 1_000_000) {
            return Err(ProviderConfigError::InvalidProvider {
                provider: config.provider.clone(),
                message: "context window must be 272000 or 1000000".into(),
            });
        }
        if self.name.trim().is_empty()
            || self.name.chars().count() > 80
            || self.name.chars().any(char::is_control)
        {
            return Err(ProviderConfigError::InvalidProvider {
                provider: config.provider.clone(),
                message: "name must contain 1 to 80 characters without control characters".into(),
            });
        }
        Ok(crate::ProviderDefinition::new(
            config.provider.clone(),
            self.name.trim(),
            match self.protocol {
                CustomProviderProtocol::AnthropicMessages => crate::ProviderAdapter::Anthropic,
                _ => crate::ProviderAdapter::OpenAiCompatible,
            },
            match self.protocol {
                CustomProviderProtocol::Responses => ApiProfile::OpenAiResponses,
                CustomProviderProtocol::ChatCompletions => ApiProfile::OpenAiChatCompletions,
                CustomProviderProtocol::AnthropicMessages => ApiProfile::AnthropicMessages,
            },
            crate::EndpointPolicy::ProviderDefault {
                base_url: base_url.into(),
            },
            crate::ModelCatalogPolicy::AllowUnlisted,
        )
        .with_models(self.catalog_models())
        .with_api_key_header(match self.protocol {
            CustomProviderProtocol::AnthropicMessages => crate::ApiKeyHeader::XApiKey,
            _ => crate::ApiKeyHeader::Bearer,
        })
        .with_defaults(crate::ProviderDefaults {
            max_output_tokens: Some(if self.context_window == 1_000_000 {
                32_768
            } else {
                8_192
            }),
            ..Default::default()
        })
        .with_api_key_policy(crate::ApiKeyPolicy::Optional)
        .with_native_streaming())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedModelProviderConfig {
    pub provider: ProviderId,
    pub api_profile: ApiProfile,
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_token_count: Option<NormalizedInputTokenCountConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
}

pub(crate) fn normalize_base_url(value: &str, rule: BaseUrlNormalization) -> String {
    match rule {
        BaseUrlNormalization::Preserve => value.into(),
        BaseUrlNormalization::Trim => value.trim().into(),
        BaseUrlNormalization::TrimAndRemoveTrailingSlash => {
            value.trim().trim_end_matches('/').into()
        }
    }
}

pub(crate) fn is_http_url(value: &str) -> bool {
    let Some(authority_and_path) = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
    else {
        return false;
    };
    let authority = authority_and_path.split('/').next().unwrap_or_default();
    !authority.is_empty() && !authority.chars().any(char::is_whitespace)
}

fn default_custom_context_window() -> u32 {
    272_000
}
