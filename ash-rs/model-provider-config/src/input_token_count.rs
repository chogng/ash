use crate::BaseUrlNormalization;
use crate::ProviderConfigError;
use crate::ProviderId;
use crate::config::is_http_url;
use crate::config::normalize_base_url;
use ash_protocol::ModelId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeSet;

/// A declarative provider preflight protocol understood by the runtime codec layer.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InputTokenCountProfile {
    OpenAiResponses,
    AnthropicMessages,
    GoogleGenerateContent,
    KimiChatCompletions,
    ZaiChatCompletions,
}

/// Selects where a provider's token-count protocol is served.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum InputTokenCountTarget {
    /// Reuse the normalized invocation base URL, including explicit user overrides.
    InvocationBase,
    /// Use a provider-owned endpoint only while invocation also uses provider defaults.
    ProviderDefault { base_url: String },
}

/// Declares which model IDs are eligible for one provider preflight protocol.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum InputTokenCountModelPolicy {
    AllModels,
    ListedModels { models: Vec<ModelId> },
}

impl InputTokenCountModelPolicy {
    pub fn supports(&self, model: &ModelId) -> bool {
        match self {
            Self::AllModels => true,
            Self::ListedModels { models } => models.contains(model),
        }
    }
}

/// Provider-owned declaration of a pre-invocation token-count endpoint.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputTokenCountDefinition {
    pub profile: InputTokenCountProfile,
    pub target: InputTokenCountTarget,
    pub models: InputTokenCountModelPolicy,
}

impl InputTokenCountDefinition {
    pub fn invocation_base(profile: InputTokenCountProfile) -> Self {
        Self {
            profile,
            target: InputTokenCountTarget::InvocationBase,
            models: InputTokenCountModelPolicy::AllModels,
        }
    }

    pub fn provider_default(profile: InputTokenCountProfile, base_url: impl Into<String>) -> Self {
        Self {
            profile,
            target: InputTokenCountTarget::ProviderDefault {
                base_url: base_url.into(),
            },
            models: InputTokenCountModelPolicy::AllModels,
        }
    }

    pub fn with_models(mut self, models: impl IntoIterator<Item = ModelId>) -> Self {
        self.models = InputTokenCountModelPolicy::ListedModels {
            models: models.into_iter().collect(),
        };
        self
    }

    pub(crate) fn validate(&self, provider: &ProviderId) -> Result<(), ProviderConfigError> {
        if let InputTokenCountTarget::ProviderDefault { base_url } = &self.target
            && !is_http_url(&normalize_base_url(
                base_url,
                BaseUrlNormalization::TrimAndRemoveTrailingSlash,
            ))
        {
            return Err(ProviderConfigError::InvalidBaseUrl {
                provider: provider.clone(),
                base_url: base_url.clone(),
            });
        }
        if let InputTokenCountModelPolicy::ListedModels { models } = &self.models {
            if models.is_empty() {
                return Err(ProviderConfigError::InvalidProvider {
                    provider: provider.clone(),
                    message: "input token count model list must not be empty".into(),
                });
            }
            let unique = models.iter().collect::<BTreeSet<_>>();
            if unique.len() != models.len() {
                return Err(ProviderConfigError::InvalidProvider {
                    provider: provider.clone(),
                    message: "input token count model list contains duplicates".into(),
                });
            }
        }
        Ok(())
    }
}

/// Runtime-ready token-count configuration frozen with one provider snapshot.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedInputTokenCountConfig {
    pub profile: InputTokenCountProfile,
    pub base_url: String,
    pub models: InputTokenCountModelPolicy,
}

impl NormalizedInputTokenCountConfig {
    pub fn supports(&self, model: &ModelId) -> bool {
        self.models.supports(model)
    }
}
