use crate::CatalogWarningCode;
use crate::ModelRequirements;
use crate::ModelsManager;
use ash_model_provider_config::ApiProfile;
use ash_model_provider_config::CustomProviderConfig;
use ash_model_provider_config::CustomProviderProtocol;
use ash_model_provider_config::EndpointPolicy;
use ash_model_provider_config::ModelCatalogPolicy;
use ash_model_provider_config::ModelContextConfig;
use ash_model_provider_config::ModelProviderConfig;
use ash_model_provider_config::ProviderAdapter;
use ash_model_provider_config::ProviderConfigError;
use ash_model_provider_config::ProviderConfigRegistry;
use ash_model_provider_config::ProviderDefinition;
use ash_protocol::ContextWindow;
use ash_protocol::ModelCapabilities;
use ash_protocol::ModelId;
use ash_protocol::ModelInfo;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;

fn model_ref() -> ModelRef {
    ModelRef::new(
        ProviderId::new("test").unwrap(),
        ModelId::new("model").unwrap(),
    )
}

fn manager(info: ModelInfo) -> ModelsManager {
    ModelsManager::new(
        ProviderConfigRegistry::from_definitions([ProviderDefinition::new(
            model_ref().provider,
            "Test",
            ProviderAdapter::OpenAiCompatible,
            ApiProfile::OpenAiResponses,
            EndpointPolicy::ConfiguredOnly,
            ModelCatalogPolicy::AllowUnlisted,
        )
        .with_models([info])])
        .unwrap(),
    )
}

#[test]
fn effective_model_info_caps_context_and_compaction_without_changing_catalog_evidence() {
    let model = model_ref();
    let mut seed = ModelInfo::new(model.model.clone(), "Model");
    seed.context_window = ContextWindow::Known(100_000);
    seed.auto_compact_token_limit = Some(95_000);
    let manager = manager(seed.clone());
    let snapshot = manager.static_snapshot(&model.provider).unwrap();
    let resolved = manager
        .resolve_static(&model, &ModelRequirements::agent())
        .unwrap();
    for (configured, window, compact) in [
        (None, 100_000, 90_000),
        (Some((200_000, None)), 100_000, 90_000),
        (Some((20_000, None)), 20_000, 18_000),
        (Some((20_000, Some(15_000))), 20_000, 15_000),
        (Some((20_000, Some(95_000))), 20_000, 18_000),
    ] {
        let mut config = ModelProviderConfig::new(model.provider.clone());
        if let Some((context_window, auto_compact_token_limit)) = configured {
            config.model_context.insert(
                model.model.clone(),
                ModelContextConfig {
                    context_window,
                    auto_compact_token_limit,
                },
            );
        }
        let mut expected = seed.clone();
        expected.context_window = ContextWindow::Known(window);
        expected.auto_compact_token_limit = Some(compact);
        assert_eq!(resolved.entry().model_info(&config).unwrap(), expected);
    }
    assert_eq!(resolved.entry().info(), &seed);
    assert_eq!(manager.static_snapshot(&model.provider).unwrap(), snapshot);
    assert_eq!(resolved.generation(), snapshot.generation());
}

#[test]
fn unlisted_model_metadata_requires_an_exact_explicit_context_configuration() {
    let model = model_ref();
    let manager = manager(ModelInfo::new(model.model, "Model"));
    let unlisted = ModelRef::new(model.provider, ModelId::new("model-new").unwrap());
    let resolved = manager
        .resolve_static(&unlisted, &ModelRequirements::agent())
        .unwrap();
    let original = resolved.clone();
    let mut config = ModelProviderConfig::new(unlisted.provider.clone());
    config.model_context.insert(
        ModelId::new("model").unwrap(),
        ModelContextConfig {
            context_window: 100_000,
            auto_compact_token_limit: None,
        },
    );
    assert_eq!(
        resolved.entry().model_info(&config).unwrap(),
        *resolved.entry().info()
    );
    config.model_context.insert(
        unlisted.model,
        ModelContextConfig {
            context_window: 32_000,
            auto_compact_token_limit: None,
        },
    );
    let info = resolved.entry().model_info(&config).unwrap();
    assert_eq!(info.context_window, ContextWindow::Known(32_000));
    assert_eq!(info.auto_compact_token_limit, Some(28_800));
    assert_eq!(info.capabilities, ModelCapabilities::UNKNOWN);
    assert_eq!(resolved, original);
    assert!(
        resolved
            .warnings()
            .iter()
            .any(|warning| warning.code() == CatalogWarningCode::UnlistedModel)
    );
}

#[test]
fn model_info_rejects_configuration_for_another_provider_and_invalid_limits() {
    let model = model_ref();
    let manager = manager(ModelInfo::new(model.model.clone(), "Model"));
    let resolved = manager
        .resolve_static(&model, &ModelRequirements::agent())
        .unwrap();
    let other = ProviderId::new("other").unwrap();
    assert_eq!(
        resolved
            .entry()
            .model_info(&ModelProviderConfig::new(other.clone())),
        Err(ProviderConfigError::ProviderMismatch {
            configured: other,
            selected: model.provider.clone(),
        })
    );
    for (context_window, auto_compact_token_limit) in [(0, None), (10_000, Some(0))] {
        let mut config = ModelProviderConfig::new(model.provider.clone());
        config.model_context.insert(
            model.model.clone(),
            ModelContextConfig {
                context_window,
                auto_compact_token_limit,
            },
        );
        assert_eq!(
            resolved.entry().model_info(&config),
            Err(ProviderConfigError::InvalidModelContext {
                provider: model.provider.clone(),
                model: model.model.clone(),
            })
        );
    }
}

#[test]
fn custom_connection_context_takes_precedence_over_per_model_configuration() {
    let provider = ProviderId::new("custom-test").unwrap();
    let model = ModelRef::new(provider.clone(), ModelId::new("custom-model").unwrap());
    let mut config = ModelProviderConfig::new(provider);
    config.base_url = Some("https://example.test/v1".into());
    config.custom = Some(CustomProviderConfig {
        model_aliases: Default::default(),
        context_window: 272_000,
        order: 0,
        model: Some(model.model.clone()),
        name: "Test".into(),
        protocol: CustomProviderProtocol::Responses,
    });
    config.model_context.insert(
        model.model.clone(),
        ModelContextConfig {
            context_window: 20_000,
            auto_compact_token_limit: Some(15_000),
        },
    );
    let registry = ProviderConfigRegistry::builtin()
        .with_configs([&config])
        .unwrap();
    let resolved = ModelsManager::new(registry)
        .resolve_static(&model, &ModelRequirements::agent())
        .unwrap();
    let info = resolved.entry().model_info(&config).unwrap();
    assert_eq!(info.context_window, ContextWindow::Known(272_000));
    assert_eq!(info.auto_compact_token_limit, Some(244_800));
}

#[test]
fn compaction_recommendation_preserves_the_ratio_for_large_windows() {
    let model = model_ref();
    let mut seed = ModelInfo::new(model.model.clone(), "Model");
    seed.context_window = ContextWindow::Known(u32::MAX);
    let resolved = manager(seed)
        .resolve_static(&model, &ModelRequirements::agent())
        .unwrap();
    assert_eq!(
        resolved
            .entry()
            .model_info(&ModelProviderConfig::new(model.provider))
            .unwrap()
            .auto_compact_token_limit,
        Some(3_865_470_565)
    );
}
