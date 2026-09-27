use crate::ProviderAccessMode;
use crate::ProviderDefinition;
use ash_protocol::ModelConnectionId;
use ash_protocol::ProviderId;

/// Authentication and execution belong to a connection, never to a model row.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ModelConnectionRuntime {
    ProviderApi,
    ChatGptSubscription,
    KimiCode,
    XaiSubscription,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelConnectionDefinition {
    pub id: ModelConnectionId,
    pub provider: ProviderId,
    pub access_mode: ProviderAccessMode,
    pub runtime: ModelConnectionRuntime,
    pub transport: ProviderDefinition,
}

/// These service identities share a model vendor, but never share credentials.
pub fn connection_provider(connection: &ModelConnectionId) -> ProviderId {
    let provider = match connection.as_str() {
        "chatgpt-subscription" => "openai",
        "kimi-subscription" => "kimi",
        "xai-subscription" => "xai",
        "bigmodel" | "bigmodel-coding-plan" | "zai-coding-plan" => "zai",
        id => id,
    };
    ProviderId::new(provider).expect("connection identity is non-empty")
}

/// One-time migration of former model identities. Connection and billing identities stay intact.
pub fn legacy_model_providers() -> std::collections::BTreeMap<ProviderId, ProviderId> {
    [
        ("bigmodel", "zai"),
        ("bigmodel-coding-plan", "zai"),
        ("zai-coding-plan", "zai"),
        ("xai-subscription", "xai"),
    ]
    .into_iter()
    .map(|(from, to)| {
        (
            ProviderId::new(from).expect("legacy provider ID"),
            ProviderId::new(to).expect("model vendor ID"),
        )
    })
    .collect()
}

pub fn builtin_connections() -> Vec<ModelConnectionDefinition> {
    let mut connections = Vec::new();
    for definition in crate::providers::builtin() {
        let id = ModelConnectionId::new(definition.id.as_str()).expect("built-in connection ID");
        let subscription = matches!(id.as_str(), "bigmodel-coding-plan" | "zai-coding-plan");
        let transport = if subscription {
            crate::providers::subscription_definition(id.as_str()).expect("coding plan definition")
        } else {
            definition
        };
        connections.push(declare(
            id,
            transport,
            if subscription {
                ProviderAccessMode::Subscription
            } else {
                ProviderAccessMode::Api
            },
            ModelConnectionRuntime::ProviderApi,
        ));
    }
    for (id, provider, runtime) in [
        (
            "chatgpt-subscription",
            "openai",
            ModelConnectionRuntime::ChatGptSubscription,
        ),
        (
            "kimi-subscription",
            "kimi",
            ModelConnectionRuntime::KimiCode,
        ),
        (
            "xai-subscription",
            "xai",
            ModelConnectionRuntime::XaiSubscription,
        ),
    ] {
        connections.push(declare(
            ModelConnectionId::new(id).expect("built-in connection ID"),
            crate::providers::subscription_definition(provider).expect("subscription definition"),
            ProviderAccessMode::Subscription,
            runtime,
        ));
    }
    connections
}

fn declare(
    id: ModelConnectionId,
    mut transport: ProviderDefinition,
    access_mode: ProviderAccessMode,
    runtime: ModelConnectionRuntime,
) -> ModelConnectionDefinition {
    let provider = connection_provider(&id);
    transport.id = provider.clone();
    // A remote listing is observation, not permission to select an Ash built-in model.
    transport.model_catalog_policy = crate::ModelCatalogPolicy::AllowUnlisted;
    crate::model_catalog::attach_static_models(std::slice::from_mut(&mut transport));
    ModelConnectionDefinition {
        id,
        provider,
        access_mode,
        runtime,
        transport,
    }
}
