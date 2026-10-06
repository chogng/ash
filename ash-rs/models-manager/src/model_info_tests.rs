use crate::CatalogWarningCode;
use crate::ModelRequirements;
use crate::ModelsManager;
use ash_protocol::ContextWindow;
use ash_protocol::ModelCapabilities;
use ash_protocol::ModelId;
use ash_protocol::ModelInfo;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use model_provider_info::ApiProfile;
use model_provider_info::CustomProviderConfig;
use model_provider_info::CustomProviderProtocol;
use model_provider_info::EndpointPolicy;
use model_provider_info::ModelCatalogPolicy;
use model_provider_info::ModelContextConfig;
use model_provider_info::ModelProviderConfig;
use model_provider_info::ProviderAdapter;
use model_provider_info::ProviderConfigError;
use model_provider_info::ProviderConfigRegistry;
use model_provider_info::ProviderDefinition;

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
                    context_window: Some(context_window),
                    long_context: None,
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
            context_window: Some(100_000),
            long_context: None,
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
            context_window: Some(32_000),
            long_context: None,
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
                context_window: Some(context_window),
                long_context: None,
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
            context_window: Some(20_000),
            long_context: None,
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
fn catalog_defaults_and_long_context_are_model_and_connection_scoped() {
    let manager = ModelsManager::new(ProviderConfigRegistry::builtin());
    for spec in model_provider_info::STATIC_MODEL_CATALOG.iter() {
        let model = spec.model_ref();
        let entry = manager
            .resolve_static(&model, &ModelRequirements::agent())
            .unwrap();
        let mut config = ModelProviderConfig::new(model.provider.clone());
        assert_eq!(
            entry.entry().model_info(&config).unwrap().context_window,
            spec.context_window
        );
        let can_expand = spec.model().context_window != spec.context_window;
        if model.provider.as_str() == "openai" && model.model.as_str() == "gpt-5.5" {
            assert_eq!(spec.context_window, ContextWindow::Known(272_000));
            assert!(!can_expand);
        }
        if model.provider.as_str() == "openai" && model.model.as_str() == "gpt-6-astra" {
            assert_eq!(
                entry
                    .entry()
                    .model_info(&config)
                    .unwrap()
                    .auto_compact_token_limit,
                Some(244_800)
            );
        }
        assert_eq!(
            entry.entry().long_context(&config),
            can_expand.then_some(false)
        );
        let original = config.clone();
        let update = crate::ModelPreferencesUpdate {
            acceleration: ash_protocol::Patch::Missing,
            long_context: Some(true),
        };
        let result = entry.entry().apply_preferences(&mut config, &update);
        if can_expand {
            result.unwrap();
            if model.provider.as_str() == "openai" && model.model.as_str() == "gpt-6-astra" {
                let effective = entry.entry().model_info(&config).unwrap();
                assert_eq!(effective.context_window, ContextWindow::Known(872_000));
                assert_eq!(effective.auto_compact_token_limit, Some(784_800));
            }
            assert_eq!(
                entry.entry().model_info(&config).unwrap().context_window,
                spec.model().context_window
            );
            assert_eq!(entry.entry().long_context(&original), Some(false));
            entry
                .entry()
                .apply_preferences(
                    &mut config,
                    &crate::ModelPreferencesUpdate {
                        acceleration: ash_protocol::Patch::Missing,
                        long_context: Some(false),
                    },
                )
                .unwrap();
            assert_eq!(
                entry.entry().model_info(&config).unwrap().context_window,
                spec.context_window
            );
        } else {
            assert!(result.is_err());
            assert_eq!(config, original);
        }
    }
}

#[test]
fn long_context_tracks_current_capacity_and_preserves_compaction() {
    let mut info = ModelInfo::new(model_ref().model, "Model");
    info.context_window = ContextWindow::Known(200_000);
    let manager = manager(info);
    let resolved = manager
        .resolve_static(&model_ref(), &ModelRequirements::agent())
        .unwrap();
    let mut entry = resolved.entry().clone();
    entry.declared_default_context_window = ContextWindow::Known(80_000);
    let mut config = ModelProviderConfig::new(model_ref().provider);
    config.model_context.insert(
        model_ref().model,
        ModelContextConfig {
            context_window: Some(70_000),
            long_context: None,
            auto_compact_token_limit: Some(45_000),
        },
    );
    let original = config.clone();
    assert!(
        entry
            .apply_preferences(
                &mut config,
                &crate::ModelPreferencesUpdate {
                    acceleration: ash_protocol::Patch::Value("unavailable".into()),
                    long_context: Some(true)
                }
            )
            .is_err()
    );
    assert_eq!(config, original);
    for (enabled, window) in [(true, 200_000), (false, 80_000)] {
        entry
            .apply_preferences(
                &mut config,
                &crate::ModelPreferencesUpdate {
                    acceleration: ash_protocol::Patch::Missing,
                    long_context: Some(enabled),
                },
            )
            .unwrap();
        let effective = entry.model_info(&config).unwrap();
        assert_eq!(effective.context_window, ContextWindow::Known(window));
        assert_eq!(effective.auto_compact_token_limit, Some(45_000));
        assert_eq!(
            config.model_context[&model_ref().model].context_window,
            None
        );
    }
    entry
        .apply_preferences(
            &mut config,
            &crate::ModelPreferencesUpdate {
                acceleration: ash_protocol::Patch::Missing,
                long_context: Some(true),
            },
        )
        .unwrap();
    // A different connection observation changes the maximum without changing the saved intent.
    let mut info = ModelInfo::new(model_ref().model, "Model");
    info.context_window = ContextWindow::Known(120_000);
    let changed = super::ModelCatalogEntry::new(
        model_ref(),
        info,
        None,
        entry.availability(),
        entry.lifecycle(),
        entry.metadata_quality(),
        entry.provenance().clone(),
        vec![],
    );
    let mut changed = changed;
    changed.declared_default_context_window = ContextWindow::Known(80_000);
    assert_eq!(
        changed.model_info(&config).unwrap().context_window,
        ContextWindow::Known(120_000)
    );
    assert_eq!(changed.long_context(&config), Some(true));
}

#[test]
fn unlisted_models_do_not_acquire_long_context_by_name() {
    let mut info = ModelInfo::new(ModelId::new("gpt-undocumented").unwrap(), "Observed model");
    info.context_window = ContextWindow::Known(600_000);
    let model = ModelRef::new(model_ref().provider, info.id.clone());
    let entry = manager(info)
        .resolve_static(&model, &ModelRequirements::agent())
        .unwrap();
    let config = ModelProviderConfig::new(model.provider);
    assert_eq!(
        entry.entry().default_context_window(&config),
        ContextWindow::Known(600_000)
    );
    assert_eq!(entry.entry().long_context(&config), None);
}

#[test]
fn model_preferences_reject_fast_on_an_unsupported_connection() {
    let model = ModelRef::new(
        ProviderId::new("xai").unwrap(),
        ModelId::new("grok-4.7").unwrap(),
    );
    let manager = ModelsManager::new(ProviderConfigRegistry::builtin());
    let entry = manager
        .resolve_static(&model, &ModelRequirements::agent())
        .unwrap();
    let mut config = ModelProviderConfig::for_connection(
        ash_protocol::ModelConnectionId::new("xai-subscription").unwrap(),
    );
    let original = config.clone();
    assert!(
        entry
            .entry()
            .apply_preferences(
                &mut config,
                &crate::ModelPreferencesUpdate {
                    acceleration: ash_protocol::Patch::Value("priority".into()),
                    long_context: None
                }
            )
            .is_err()
    );
    assert_eq!(config, original);
}

#[test]
fn acceleration_selections_and_denials_remain_scoped_to_the_connection() {
    let model = model_ref();
    let mut info = ModelInfo::new(model.model.clone(), "Model");
    info.settings.service_tiers = Some(
        [("priority", "Fast"), ("ultrafast", "Ultra Fast")]
            .into_iter()
            .map(|(id, name)| ash_protocol::ModelServiceTier {
                id: id.into(),
                name: name.into(),
                description: "Processing option".into(),
            })
            .collect(),
    );
    let entry = manager(info)
        .resolve_static(&model, &ModelRequirements::agent())
        .unwrap();
    let mut other = ModelProviderConfig::new(model.provider.clone());
    other.connection = ash_protocol::ModelConnectionId::new("another-account").unwrap();
    other
        .model_acceleration
        .insert(model.model.clone(), "priority".into());
    let untouched = other.clone();
    for disabled in [
        vec![],
        vec!["priority"],
        vec!["ultrafast"],
        vec!["priority", "ultrafast"],
    ] {
        let mut config = ModelProviderConfig::new(model.provider.clone());
        config.disabled_acceleration_options.insert(
            model.model.clone(),
            disabled.iter().map(|id| (*id).to_owned()).collect(),
        );
        let available = config.acceleration_options(entry.entry().info());
        for option in ["priority", "ultrafast"] {
            let before = config.clone();
            let result = entry.entry().apply_preferences(
                &mut config,
                &crate::ModelPreferencesUpdate {
                    acceleration: ash_protocol::Patch::Value(option.into()),
                    long_context: None,
                },
            );
            assert_eq!(
                available.iter().any(|entry| entry.id == option),
                !disabled.contains(&option)
            );
            if disabled.contains(&option) {
                assert!(result.is_err());
                assert_eq!(config, before);
            } else {
                result.unwrap();
                assert_eq!(config.model_acceleration[&model.model], option);
            }
        }
        entry
            .entry()
            .apply_preferences(
                &mut config,
                &crate::ModelPreferencesUpdate {
                    acceleration: ash_protocol::Patch::Null,
                    long_context: None,
                },
            )
            .unwrap();
        assert!(!config.model_acceleration.contains_key(&model.model));
        assert_eq!(other, untouched);
    }
}
