use crate::InputTokenCountDefinition;
use crate::ModelId;
use crate::ProviderConfigError;
use crate::ProviderId;
use crate::config::{is_http_url, normalize_base_url};
use ash_protocol::Model;
use ash_protocol::ModelOutputTransport;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderAdapter {
    OpenAi,
    OpenAiCompatible,
    Anthropic,
    Google,
    Xai,
    Qwen,
    Kimi,
    DeepSeek,
    Ollama,
    HuggingFace,
    Zai,
    MiniMax,
    Mimo,
}

/// A provider-independent model invocation API selected by a provider
/// definition.
///
/// This is a declarative value: `ash-model-provider` resolves it to an
/// executable `ash-api::ApiEndpoint` without making this configuration crate
/// depend on protocol codecs.
#[derive(
    Clone, Copy, Debug, Deserialize, Eq, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(rename_all = "camelCase")]
pub enum ApiProfile {
    OpenAiResponses,
    OpenAiChatCompletions,
    AnthropicMessages,
}

/// An exact WebSocket model-invocation protocol enabled for one provider.
///
/// This capability is deliberately independent from [`ApiProfile`]: sharing
/// an HTTP request shape does not prove that an endpoint implements the same
/// WebSocket handshake, event lifecycle, or session semantics.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WebSocketApiProfile {
    /// Do not attempt a WebSocket model invocation for this provider.
    #[default]
    Unavailable,
    /// Use the OpenAI Responses WebSocket event contract.
    OpenAiResponses,
}

/// A voice-session protocol authorized independently from text Responses support.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RealtimeApiProfile {
    #[default]
    Unavailable,
    OpenAiRealtime,
}

/// GPT-Live is declared separately from Realtime and Responses protocols.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LiveApiProfile {
    #[default]
    Unavailable,
    OpenAiLive,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum EndpointPolicy {
    ProviderDefault { base_url: String },
    ConfiguredOnly,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelCatalogPolicy {
    ListedOnly,
    AllowUnlisted,
}

/// Declares whether direct provider API calls accept an API key from the host secret store.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApiKeyPolicy {
    Unsupported,
    Optional,
    Required,
}

/// Declares how a validated provider API key is attached to direct HTTP requests.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ApiKeyHeader {
    Bearer,
    XApiKey,
    XGoogApiKey,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BaseUrlNormalization {
    Preserve,
    Trim,
    #[default]
    TrimAndRemoveTrailingSlash,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    #[serde(default)]
    pub approval_review_model: ApprovalReviewModelDefault,
}

/// Provider-owned default used when automatic approval review follows the active provider.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum ApprovalReviewModelDefault {
    /// Reuse the active Agent model when the provider has no dedicated review default.
    #[default]
    ActiveModel,
    /// Use one provider-declared model for approval review.
    Model { model: ModelId },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDefinition {
    pub id: ProviderId,
    pub name: String,
    pub adapter: ProviderAdapter,
    pub api_profile: ApiProfile,
    pub endpoint: EndpointPolicy,
    pub model_catalog_policy: ModelCatalogPolicy,
    pub api_key_policy: ApiKeyPolicy,
    pub api_key_header: ApiKeyHeader,
    #[serde(default)]
    pub output_transport: ModelOutputTransport,
    #[serde(default)]
    pub websocket_api_profile: WebSocketApiProfile,
    #[serde(default)]
    pub realtime_api_profile: RealtimeApiProfile,
    #[serde(default)]
    pub live_api_profile: LiveApiProfile,
    #[serde(default)]
    pub models: Vec<Model>,
    #[serde(default)]
    pub defaults: ProviderDefaults,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_token_count: Option<InputTokenCountDefinition>,
    #[serde(default)]
    pub base_url_normalization: BaseUrlNormalization,
}

impl ProviderDefinition {
    pub fn new(
        id: ProviderId,
        name: impl Into<String>,
        adapter: ProviderAdapter,
        api_profile: ApiProfile,
        endpoint: EndpointPolicy,
        model_catalog_policy: ModelCatalogPolicy,
    ) -> Self {
        Self {
            id,
            name: name.into(),
            adapter,
            api_profile,
            endpoint,
            model_catalog_policy,
            api_key_policy: ApiKeyPolicy::Required,
            api_key_header: ApiKeyHeader::Bearer,
            output_transport: ModelOutputTransport::Unary,
            websocket_api_profile: WebSocketApiProfile::Unavailable,
            realtime_api_profile: RealtimeApiProfile::Unavailable,
            live_api_profile: LiveApiProfile::Unavailable,
            models: Vec::new(),
            defaults: ProviderDefaults::default(),
            input_token_count: None,
            base_url_normalization: BaseUrlNormalization::default(),
        }
    }

    pub fn with_models(mut self, models: impl IntoIterator<Item = Model>) -> Self {
        self.models.extend(models);
        self
    }

    pub fn with_native_streaming(mut self) -> Self {
        self.output_transport = ModelOutputTransport::NativeStreaming;
        self
    }

    pub fn with_api_key_policy(mut self, policy: ApiKeyPolicy) -> Self {
        self.api_key_policy = policy;
        self
    }

    pub fn with_api_key_header(mut self, header: ApiKeyHeader) -> Self {
        self.api_key_header = header;
        self
    }

    pub fn with_websocket_api_profile(mut self, profile: WebSocketApiProfile) -> Self {
        self.websocket_api_profile = profile;
        self
    }

    pub fn with_realtime_api_profile(mut self, profile: RealtimeApiProfile) -> Self {
        self.realtime_api_profile = profile;
        self
    }

    pub fn with_live_api_profile(mut self, profile: LiveApiProfile) -> Self {
        self.live_api_profile = profile;
        self
    }

    pub fn with_default_model(mut self, model: Model) -> Self {
        self.defaults.approval_review_model = ApprovalReviewModelDefault::Model {
            model: model.id.clone(),
        };
        self.models.push(model);
        self
    }

    pub fn with_defaults(mut self, defaults: ProviderDefaults) -> Self {
        self.defaults = defaults;
        self
    }

    pub fn with_input_token_count(mut self, definition: InputTokenCountDefinition) -> Self {
        self.input_token_count = Some(definition);
        self
    }

    pub fn with_base_url_normalization(mut self, rule: BaseUrlNormalization) -> Self {
        self.base_url_normalization = rule;
        self
    }

    pub fn validate(&self) -> Result<(), ProviderConfigError> {
        if self.name.trim().is_empty() {
            return Err(self.invalid("display name must not be empty"));
        }
        if let EndpointPolicy::ProviderDefault { base_url } = &self.endpoint
            && !is_http_url(&normalize_base_url(base_url, self.base_url_normalization))
        {
            return Err(ProviderConfigError::InvalidBaseUrl {
                provider: self.id.clone(),
                base_url: base_url.clone(),
            });
        }
        if self.defaults.max_output_tokens == Some(0) {
            return Err(ProviderConfigError::InvalidMaxOutputTokens(self.id.clone()));
        }
        if self.websocket_api_profile == WebSocketApiProfile::OpenAiResponses
            && self.api_profile != ApiProfile::OpenAiResponses
        {
            return Err(self.invalid(
                "OpenAI Responses WebSocket requires the OpenAI Responses HTTP API profile",
            ));
        }
        if let Some(input_token_count) = &self.input_token_count {
            input_token_count.validate(&self.id)?;
        }
        if let ApprovalReviewModelDefault::Model { model } = &self.defaults.approval_review_model
            && self.model_catalog_policy == ModelCatalogPolicy::ListedOnly
            && !self.models.iter().any(|candidate| &candidate.id == model)
        {
            return Err(self.invalid(format!(
                "approval review model '{}' is not present in its listed model catalog",
                model
            )));
        }
        let mut model_ids = BTreeSet::new();
        for model in &self.models {
            if !model_ids.insert(model.id.clone()) {
                return Err(self.invalid(format!("duplicate model ID '{}'", model.id)));
            }
            if model.display_name.trim().is_empty() {
                return Err(self.invalid(format!(
                    "model '{}' display name must not be empty",
                    model.id
                )));
            }
        }
        Ok(())
    }

    fn invalid(&self, message: impl Into<String>) -> ProviderConfigError {
        ProviderConfigError::InvalidProvider {
            provider: self.id.clone(),
            message: message.into(),
        }
    }
}
