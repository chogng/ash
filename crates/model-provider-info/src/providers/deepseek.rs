use super::default_provider;
use crate::{ApiProfile, ProviderAdapter, ProviderDefinition};

pub(super) fn definition() -> ProviderDefinition {
    let mut definition = default_provider(
        "deepseek",
        "DeepSeek",
        ProviderAdapter::DeepSeek,
        ApiProfile::OpenAiChatCompletions,
        "https://api.deepseek.com",
    )
    .with_native_streaming();
    definition.defaults.approval_review_model = crate::ApprovalReviewModelDefault::Model {
        model: crate::ModelId::new("deepseek-v4-pro").expect("built-in model ID"),
    };
    definition
}
