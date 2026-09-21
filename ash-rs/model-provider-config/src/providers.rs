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
mod zai;

pub(crate) fn builtin() -> [ProviderDefinition; 14] {
    [
        openai::definition(),
        openai_compatible::definition(),
        google::definition(),
        xai::definition(),
        xai::subscription_definition(),
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
