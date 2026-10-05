use super::default_provider;
use crate::{ApiKeyPolicy, ApiProfile, ProviderAdapter, ProviderDefinition};

pub(super) fn definition() -> ProviderDefinition {
    default_provider(
        "ollama",
        "Ollama",
        ProviderAdapter::Ollama,
        ApiProfile::OpenAiChatCompletions,
        "http://localhost:11434/v1",
    )
    .with_native_streaming()
    .with_api_key_policy(ApiKeyPolicy::Unsupported)
}
