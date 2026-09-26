use super::configured_provider;
use super::default_provider;
use crate::ApiProfile;
use crate::InputTokenCountDefinition;
use crate::InputTokenCountProfile;
use crate::ModelId;
use crate::ProviderAdapter;
use crate::ProviderDefinition;

pub const BIGMODEL_CODING_PLAN_BASE_URL: &str = "https://open.bigmodel.cn/api/coding/paas/v4";

pub(super) fn definition() -> ProviderDefinition {
    default_provider(
        "bigmodel",
        "BigModel",
        ProviderAdapter::Zai,
        ApiProfile::OpenAiChatCompletions,
        "https://open.bigmodel.cn/api/paas/v4",
    )
    .with_native_streaming()
    .with_input_token_count(InputTokenCountDefinition::invocation_base(
        InputTokenCountProfile::ZaiChatCompletions,
    ))
}

/// The Coding Plan has its own provider ID and credential, even though its wire protocol is
/// shared with BigModel API and Z.ai API.
pub(super) fn coding_plan_definition() -> ProviderDefinition {
    configured_provider(
        "bigmodel-coding-plan",
        "BigModel",
        ProviderAdapter::Zai,
        ApiProfile::OpenAiChatCompletions,
    )
    .with_native_streaming()
    .with_input_token_count(
        InputTokenCountDefinition::invocation_base(InputTokenCountProfile::ZaiChatCompletions)
            .with_models([ModelId::new("glm-5.1").expect("valid model ID")]),
    )
}

pub(super) fn subscription_definition() -> ProviderDefinition {
    let mut definition = default_provider(
        "bigmodel-coding-plan",
        "BigModel",
        ProviderAdapter::Zai,
        ApiProfile::OpenAiChatCompletions,
        BIGMODEL_CODING_PLAN_BASE_URL,
    )
    .with_native_streaming()
    .with_input_token_count(
        InputTokenCountDefinition::invocation_base(InputTokenCountProfile::ZaiChatCompletions)
            .with_models([ModelId::new("glm-5.1").expect("valid model ID")]),
    );
    definition.model_catalog_policy = crate::ModelCatalogPolicy::ListedOnly;
    definition
}
