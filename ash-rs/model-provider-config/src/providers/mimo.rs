use super::default_provider;
use crate::{ApiProfile, ProviderAdapter, ProviderDefinition};

pub(super) fn definition() -> ProviderDefinition {
    let mut definition = default_provider(
        "mimo",
        "Xiaomi MiMo",
        ProviderAdapter::Mimo,
        ApiProfile::OpenAiChatCompletions,
        "https://api.xiaomimimo.com/v1",
    )
    .with_native_streaming();
    definition.defaults.approval_review_model = crate::ApprovalReviewModelDefault::Model {
        model: crate::ModelId::new("mimo-v2.5-pro").expect("built-in model ID"),
    };
    definition
}
