use super::default_provider;
use crate::ApiProfile;
use crate::InputTokenCountDefinition;
use crate::InputTokenCountProfile;
use crate::ModelId;
use crate::ProviderAdapter;
use crate::ProviderDefinition;

/// The GLM Coding Plan endpoint. The plan reuses the standard Z.AI API key, so pointing the
/// zai connection at this URL is how a user selects plan access over pay-as-you-go API access.
pub const ZAI_CODING_PLAN_BASE_URL: &str = "https://api.z.ai/api/coding/paas/v4";

pub(super) fn definition() -> ProviderDefinition {
    default_provider(
        "zai",
        "Z.AI (GLM)",
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

/// GLM Coding Plan models are served through the coding endpoint with the same API key and
/// adapter as the standard endpoint, so the catalog is restricted to the plan's listed models.
/// The coding gateway routes the standard `POST /tokenizer` measurement endpoint to the same
/// key, so plan access keeps the provider preflight measurement.
pub(super) fn subscription_definition() -> ProviderDefinition {
    let mut definition = default_provider(
        "zai",
        "GLM Coding Plan",
        ProviderAdapter::Zai,
        ApiProfile::OpenAiChatCompletions,
        ZAI_CODING_PLAN_BASE_URL,
    )
    .with_native_streaming()
    .with_input_token_count(
        InputTokenCountDefinition::invocation_base(InputTokenCountProfile::ZaiChatCompletions)
            .with_models([ModelId::new("glm-5.1").expect("valid model ID")]),
    );
    definition.model_catalog_policy = crate::ModelCatalogPolicy::ListedOnly;
    definition
}
