use super::default_provider;
use crate::{ApiProfile, ProviderAdapter, ProviderDefinition};

pub(super) fn definition() -> ProviderDefinition {
    let mut definition = default_provider(
        "qwen",
        "Qwen",
        ProviderAdapter::Qwen,
        ApiProfile::OpenAiChatCompletions,
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
    )
    .with_native_streaming();
    definition.defaults.approval_review_model = crate::ApprovalReviewModelDefault::Model {
        model: crate::ModelId::new("qwen-plus").expect("built-in model ID"),
    };
    definition
}
