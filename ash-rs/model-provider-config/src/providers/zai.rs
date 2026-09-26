use super::{configured_provider, default_provider};
use crate::ApiProfile;
use crate::InputTokenCountDefinition;
use crate::InputTokenCountProfile;
use crate::ModelId;
use crate::ProviderAdapter;
use crate::ProviderDefinition;

pub const ZAI_CODING_PLAN_BASE_URL: &str = "https://api.z.ai/api/coding/paas/v4";

pub(super) fn definition() -> ProviderDefinition {
    default_provider(
        "zai",
        "Z.AI",
        ProviderAdapter::Zai,
        ApiProfile::OpenAiChatCompletions,
        "https://api.z.ai/api/paas/v4",
    )
    .with_native_streaming()
    .with_input_token_count(
        InputTokenCountDefinition::invocation_base(InputTokenCountProfile::ZaiChatCompletions)
            .with_models([
                ModelId::new("glm-4.6").expect("valid model ID"),
                ModelId::new("glm-4.6v").expect("valid model ID"),
                ModelId::new("glm-4.5").expect("valid model ID"),
            ]),
    )
}

pub(super) fn coding_plan_definition() -> ProviderDefinition {
    configured_provider(
        "zai-coding-plan",
        "Z.AI",
        ProviderAdapter::Zai,
        ApiProfile::OpenAiChatCompletions,
    )
    .with_native_streaming()
    .with_input_token_count(
        InputTokenCountDefinition::invocation_base(InputTokenCountProfile::ZaiChatCompletions)
            .with_models([
                ModelId::new("glm-5.3").expect("valid model ID"),
                ModelId::new("glm-5.3-flash").expect("valid model ID"),
                ModelId::new("glm-5.1").expect("valid model ID"),
            ]),
    )
}

pub(super) fn subscription_definition() -> ProviderDefinition {
    let mut definition = default_provider(
        "zai-coding-plan",
        "Z.AI",
        ProviderAdapter::Zai,
        ApiProfile::OpenAiChatCompletions,
        ZAI_CODING_PLAN_BASE_URL,
    )
    .with_native_streaming()
    .with_input_token_count(
        InputTokenCountDefinition::invocation_base(InputTokenCountProfile::ZaiChatCompletions)
            .with_models([
                ModelId::new("glm-5.3").expect("valid model ID"),
                ModelId::new("glm-5.3-flash").expect("valid model ID"),
                ModelId::new("glm-5.1").expect("valid model ID"),
            ]),
    );
    definition.model_catalog_policy = crate::ModelCatalogPolicy::ListedOnly;
    definition
}
