use super::default_provider;
use crate::ApiProfile;
use crate::InputTokenCountDefinition;
use crate::InputTokenCountProfile;
use crate::ModelId;
use crate::ProviderAdapter;
use crate::ProviderDefinition;

pub(super) fn definition() -> ProviderDefinition {
    let mut definition = default_provider(
        "kimi",
        "Kimi",
        ProviderAdapter::Kimi,
        ApiProfile::OpenAiChatCompletions,
        "https://api.moonshot.ai/v1",
    )
    .with_native_streaming()
    .with_input_token_count(
        InputTokenCountDefinition::invocation_base(InputTokenCountProfile::KimiChatCompletions)
            .with_models([
                ModelId::new("kimi-k3").expect("valid model ID"),
                ModelId::new("kimi-k2.7-code").expect("valid model ID"),
                ModelId::new("kimi-k2.6").expect("valid model ID"),
                ModelId::new("kimi-k2.5").expect("valid model ID"),
                ModelId::new("kimi-k2.7-code-highspeed").expect("valid model ID"),
                ModelId::new("moonshot-v1-8k").expect("valid model ID"),
                ModelId::new("moonshot-v1-32k").expect("valid model ID"),
                ModelId::new("moonshot-v1-128k").expect("valid model ID"),
                ModelId::new("moonshot-v1-auto").expect("valid model ID"),
                ModelId::new("moonshot-v1-8k-vision-preview").expect("valid model ID"),
                ModelId::new("moonshot-v1-32k-vision-preview").expect("valid model ID"),
                ModelId::new("moonshot-v1-128k-vision-preview").expect("valid model ID"),
            ]),
    );
    definition.defaults.approval_review_model = crate::ApprovalReviewModelDefault::Model {
        model: crate::ModelId::new("kimi-k2.6").expect("built-in model ID"),
    };
    definition
}

/// Kimi Code subscription models use the coding endpoint with OAuth credentials.
pub(super) fn subscription_definition() -> ProviderDefinition {
    let mut definition = default_provider(
        "kimi",
        "Kimi",
        ProviderAdapter::Kimi,
        ApiProfile::OpenAiChatCompletions,
        "https://api.kimi.com/coding/v1",
    )
    .with_native_streaming();
    definition.api_key_policy = crate::ApiKeyPolicy::Unsupported;
    definition.model_catalog_policy = crate::ModelCatalogPolicy::ListedOnly;
    definition
}

pub(super) fn desktop_definition() -> ProviderDefinition {
    let mut definition = default_provider(
        "kimi-desktop",
        "Kimi Desktop",
        ProviderAdapter::Kimi,
        ApiProfile::OpenAiChatCompletions,
        "https://agent-gw.kimi.com/coding/v1",
    )
    .with_native_streaming();
    definition.api_key_policy = crate::ApiKeyPolicy::Unsupported;
    definition
}

pub(super) fn cli_definition() -> ProviderDefinition {
    let mut definition = default_provider(
        "kimi-cli",
        "Kimi Code CLI",
        ProviderAdapter::Kimi,
        ApiProfile::OpenAiChatCompletions,
        "https://api.kimi.com/coding/v1",
    )
    .with_native_streaming();
    definition.api_key_policy = crate::ApiKeyPolicy::Unsupported;
    definition
}
