use super::configured_provider;
use crate::{ApiKeyPolicy, ApiProfile, ProviderAdapter, ProviderDefinition};

pub(super) fn definition() -> ProviderDefinition {
    configured_provider(
        "openai-compatible",
        "OpenAI-compatible",
        ProviderAdapter::OpenAiCompatible,
        ApiProfile::OpenAiChatCompletions,
    )
    .with_api_key_policy(ApiKeyPolicy::Optional)
    .with_native_streaming()
}
