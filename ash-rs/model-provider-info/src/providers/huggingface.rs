use super::default_provider;
use crate::{ApiProfile, ProviderAdapter, ProviderDefinition};

pub(super) fn definition() -> ProviderDefinition {
    default_provider(
        "huggingface",
        "Hugging Face",
        ProviderAdapter::HuggingFace,
        ApiProfile::OpenAiChatCompletions,
        "https://router.huggingface.co/v1",
    )
    .with_native_streaming()
}
