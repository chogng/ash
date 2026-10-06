use crate::{
    ApiProfile, EndpointPolicy, ModelCatalogPolicy, ProviderAdapter, ProviderDefinition, ProviderId,
};

mod anthropic;
pub(super) mod bigmodel;
mod deepseek;
mod google;
mod kimi;
mod meta;
mod ollama;
mod openai;
mod openai_compatible;
mod xai;
pub(super) mod zai;

pub(crate) fn builtin() -> [ProviderDefinition; 15] {
    [
        openai::definition(),
        openai_compatible::definition(),
        google::definition(),
        xai::definition(),
        kimi::definition(),
        deepseek::definition(),
        ollama::definition(),
        bigmodel::definition(),
        bigmodel::coding_plan_definition(),
        zai::definition(),
        zai::coding_plan_definition(),
        start_plan_definition("bigmodel-start-plan", "BigModel Start Plan"),
        start_plan_definition("zai-start-plan", "Z.AI Start Plan"),
        anthropic::definition(),
        meta::definition(),
    ]
}

pub(crate) fn subscription_definition(id: &str) -> Option<ProviderDefinition> {
    match id {
        "openai" => Some(openai::subscription_definition()),
        "xai" => Some(xai::subscription_definition()),
        "kimi" => Some(kimi::subscription_definition()),
        "kimi-desktop" => Some(kimi::desktop_definition()),
        "kimi-cli" => Some(kimi::cli_definition()),
        "bigmodel-coding-plan" => Some(bigmodel::coding_plan_definition()),
        "zai-coding-plan" => Some(zai::coding_plan_definition()),
        "bigmodel-start-plan" => Some(start_plan_definition(id, "BigModel Start Plan")),
        "zai-start-plan" => Some(start_plan_definition(id, "Z.AI Start Plan")),
        _ => None,
    }
}

pub(crate) fn glm_model_definition() -> ProviderDefinition {
    let mut definition = configured_provider(
        "glm",
        "GLM",
        ProviderAdapter::Zai,
        ApiProfile::OpenAiChatCompletions,
    )
    .with_native_streaming();
    crate::model_catalog::attach_static_models(std::slice::from_mut(&mut definition));
    definition
}

pub(super) fn default_provider(
    id: &str,
    name: &str,
    adapter: ProviderAdapter,
    api_profile: ApiProfile,
    base_url: &str,
) -> ProviderDefinition {
    ProviderDefinition::new(
        ProviderId::new(id).expect("valid provider ID"),
        name,
        adapter,
        api_profile,
        EndpointPolicy::ProviderDefault {
            base_url: base_url.into(),
        },
        ModelCatalogPolicy::AllowUnlisted,
    )
}

pub(super) fn configured_provider(
    id: &str,
    name: &str,
    adapter: ProviderAdapter,
    api_profile: ApiProfile,
) -> ProviderDefinition {
    ProviderDefinition::new(
        ProviderId::new(id).expect("valid provider ID"),
        name,
        adapter,
        api_profile,
        EndpointPolicy::ConfiguredOnly,
        ModelCatalogPolicy::AllowUnlisted,
    )
}

fn start_plan_definition(id: &str, name: &str) -> ProviderDefinition {
    default_provider(
        id,
        name,
        ProviderAdapter::Anthropic,
        ApiProfile::AnthropicMessages,
        "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
    )
    .with_native_streaming()
    .with_api_key_policy(crate::ApiKeyPolicy::Unsupported)
    .with_defaults(crate::ProviderDefaults {
        max_output_tokens: Some(4096),
        ..crate::ProviderDefaults::default()
    })
}
