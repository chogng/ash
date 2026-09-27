use super::default_provider;
use crate::ApiProfile;
use crate::InputTokenCountDefinition;
use crate::InputTokenCountProfile;
use crate::ModelId;
use crate::ProviderAdapter;
use crate::ProviderDefinition;

pub const BIGMODEL_CODING_PLAN_BASE_URL: &str = "https://open.bigmodel.cn/api/coding/paas/v4";

pub(super) fn definition() -> ProviderDefinition {
    let mut definition = default_provider(
        "bigmodel",
        "BigModel",
        ProviderAdapter::Zai,
        ApiProfile::OpenAiChatCompletions,
        "https://open.bigmodel.cn/api/paas/v4",
    )
    .with_native_streaming()
    .with_input_token_count(InputTokenCountDefinition::invocation_base(
        InputTokenCountProfile::ZaiChatCompletions,
    ));
    definition.defaults.approval_review_model = crate::ApprovalReviewModelDefault::Model {
        model: crate::ModelId::new("glm-5.1").expect("built-in model ID"),
    };
    definition
}

/// The Coding Plan has its own connection ID and credential, even though its wire protocol is
/// shared with BigModel API and Z.ai API.
pub(super) fn coding_plan_definition() -> ProviderDefinition {
    default_provider(
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
    )
}
