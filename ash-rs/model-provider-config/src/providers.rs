use crate::{
    ApiProfile, EndpointPolicy, ModelCatalogPolicy, ProviderAdapter, ProviderDefinition, ProviderId,
};

mod anthropic;
mod deepseek;
mod google;
mod huggingface;
mod kimi;
mod mimo;
mod minimax;
mod ollama;
mod openai;
mod openai_compatible;
mod qwen;
mod xai;
pub(super) mod zai;

pub(crate) fn builtin() -> [ProviderDefinition; 13] {
    [
        openai::definition(),
        openai_compatible::definition(),
        google::definition(),
        xai::definition(),
        qwen::definition(),
        kimi::definition(),
        deepseek::definition(),
        ollama::definition(),
        huggingface::definition(),
        zai::definition(),
        minimax::definition(),
        mimo::definition(),
        anthropic::definition(),
    ]
}

pub(crate) fn subscription_definition(id: &str) -> Option<ProviderDefinition> {
    match id {
        "openai" => Some(openai::subscription_definition()),
        "xai" => Some(xai::subscription_definition()),
        "kimi" => Some(kimi::subscription_definition()),
        "zai" => Some(zai::subscription_definition()),
        _ => None,
    }
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
