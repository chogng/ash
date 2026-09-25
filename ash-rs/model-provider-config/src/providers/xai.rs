use super::default_provider;
use crate::{ApiProfile, ProviderAdapter, ProviderDefinition};

pub(super) fn definition() -> ProviderDefinition {
    default_provider(
        "xai",
        "xAI (Grok)",
        ProviderAdapter::Xai,
        ApiProfile::OpenAiResponses,
        "https://api.x.ai/v1",
    )
    .with_native_streaming()
}

/// Subscription credentials only ever target the Grok CLI proxy.
pub(super) fn subscription_definition() -> ProviderDefinition {
    let mut definition = default_provider(
        "xai",
        "xAI Subscription",
        ProviderAdapter::Xai,
        ApiProfile::OpenAiResponses,
        "https://cli-chat-proxy.grok.com/v1",
    )
    .with_native_streaming();
    definition.api_key_policy = crate::ApiKeyPolicy::Unsupported;
    definition.model_catalog_policy = crate::ModelCatalogPolicy::DiscoveredOnly;
    definition
}
