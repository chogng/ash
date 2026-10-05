use super::default_provider;
use crate::{ApiProfile, ProviderAdapter, ProviderDefinition};

pub(super) fn definition() -> ProviderDefinition {
    let mut definition = default_provider(
        "minimax",
        "MiniMax",
        ProviderAdapter::MiniMax,
        ApiProfile::OpenAiChatCompletions,
        "https://api.minimax.io/v1",
    )
    .with_native_streaming();
    definition.defaults.approval_review_model = crate::ApprovalReviewModelDefault::Model {
        model: crate::ModelId::new("MiniMax-M3").expect("built-in model ID"),
    };
    definition
}
