use super::default_provider;
use crate::{ApiProfile, ProviderAdapter, ProviderDefinition};

pub(super) fn definition() -> ProviderDefinition {
    // Meta documents Responses compatibility, including streaming and tool calls:
    // https://dev.meta.ai/docs/overview
    default_provider(
        "meta",
        "Meta",
        ProviderAdapter::OpenAiCompatible,
        ApiProfile::OpenAiResponses,
        "https://api.meta.ai/v1",
    )
    .with_native_streaming()
}
