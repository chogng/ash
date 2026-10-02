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
fn per_model_context_overrides_the_custom_connection_default() {
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
    assert_eq!(info.context_window, ContextWindow::Known(20_000));
    assert_eq!(info.auto_compact_token_limit, Some(15_000));
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

#[test]
fn effective_fast_mode_support_follows_the_connection_without_mutating_static_evidence() {
    use ash_protocol::CapabilitySupport;
    use ash_protocol::ModelConnectionId;
    let manager = ModelsManager::new(ProviderConfigRegistry::builtin());
    for (provider, model, connection, expected) in [
        ("xai", "grok-4.7", "xai", CapabilitySupport::Supported),
        (
            "xai",
            "grok-4.7",
            "xai-subscription",
            CapabilitySupport::Unsupported,
        ),
        (
            "kimi",
            "kimi-k2.7-code",
            "kimi",
            CapabilitySupport::Unsupported,
        ),
        (
            "kimi",
            "kimi-k2.7-code",
            "kimi-subscription",
            CapabilitySupport::Supported,
        ),
    ] {
        let model = ModelRef::new(
            ProviderId::new(provider).unwrap(),
            ModelId::new(model).unwrap(),
        );
        let resolved = manager
            .resolve_static(&model, &ModelRequirements::agent())
            .unwrap();
        let config =
            ModelProviderConfig::for_connection(ModelConnectionId::new(connection).unwrap());
        assert_eq!(
            resolved
                .entry()
                .model_info(&config)
                .unwrap()
                .capabilities
                .fast_mode,
            expected
        );
        assert_eq!(
            resolved.entry().info().capabilities.fast_mode,
            CapabilitySupport::Supported
        );
    }
}

#[test]
fn every_builtin_gpt_uses_272k_by_default_and_preserves_explicit_budgets() {
    let manager = ModelsManager::new(ProviderConfigRegistry::builtin());
    let mut count = 0;
    for spec in ash_model_provider_config::STATIC_MODEL_CATALOG
        .iter()
        .filter(|spec| spec.model_id.starts_with("gpt-"))
    {
        count += 1;
        let model = spec.model_ref();
        let resolved = manager
            .resolve_static(&model, &ModelRequirements::agent())
            .unwrap();
        let mut config = ModelProviderConfig::new(model.provider.clone());
        let ContextWindow::Known(ceiling) = spec.context_window else {
            panic!("GPT ceiling must be declared")
        };
        let default = resolved.entry().model_info(&config).unwrap();
        let window = ceiling.min(272_000);
        assert_eq!(
            default.context_window,
            ContextWindow::Known(window),
            "{}",
            spec.model_id
        );
        assert_eq!(default.auto_compact_token_limit, Some(window * 9 / 10));
        assert_eq!(resolved.entry().info().context_window, spec.context_window);
        config.model_context.insert(
            model.model,
            ModelContextConfig {
                context_window: 1_000_000,
                auto_compact_token_limit: None,
            },
        );
        assert_eq!(
            resolved.entry().model_info(&config).unwrap().context_window,
            ContextWindow::Known(ceiling.min(1_000_000))
        );
    }
    assert!(count > 0);
}
