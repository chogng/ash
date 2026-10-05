use super::default_provider;
use crate::{ApiProfile, ProviderAdapter, ProviderDefinition};

pub(super) fn definition() -> ProviderDefinition {
    let mut definition = default_provider(
        "xai",
        "xAI",
        ProviderAdapter::Xai,
        ApiProfile::OpenAiResponses,
        "https://api.x.ai/v1",
    )
    .with_native_streaming()
    .with_transcription_api_profile(crate::TranscriptionApiProfile::XaiStt);
    definition.defaults.approval_review_model = crate::ApprovalReviewModelDefault::Model {
        model: crate::ModelId::new("grok-4.5").expect("built-in model ID"),
    };
    definition
}

/// Subscription credentials only ever target the Grok CLI proxy.
pub(super) fn subscription_definition() -> ProviderDefinition {
    let mut definition = default_provider(
        "xai",
        "Super Grok",
        ProviderAdapter::Xai,
        ApiProfile::OpenAiResponses,
        "https://cli-chat-proxy.grok.com/v1",
    )
    .with_native_streaming();
    definition.api_key_policy = crate::ApiKeyPolicy::Unsupported;
    definition.model_catalog_policy = crate::ModelCatalogPolicy::DiscoveredOnly;
    definition
}
