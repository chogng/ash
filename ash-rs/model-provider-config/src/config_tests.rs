use super::*;
use serde_json::json;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

fn provider_id(value: &str) -> ProviderId {
    ProviderId::new(value).unwrap()
}

#[test]
fn custom_context_presets_set_internal_output_limits() {
    for protocol in [
        CustomProviderProtocol::Responses,
        CustomProviderProtocol::ChatCompletions,
        CustomProviderProtocol::AnthropicMessages,
    ] {
        for (window, output) in [(272_000, 8_192), (1_000_000, 32_768)] {
            let model = ModelId::new("remote-alias").unwrap();
            let mut config = ModelProviderConfig::new(provider_id("custom-test"));
            config.custom = Some(CustomProviderConfig {
                context_window: window,
                order: 0,
                model: Some(model.clone()),
                name: "Test".into(),
                protocol,
            });
            config.base_url = Some("https://example.invalid/v1".into());
            config.model_context.insert(
                model,
                ModelContextConfig {
                    context_window: window,
                    auto_compact_token_limit: None,
                },
            );
            let registry = ProviderConfigRegistry::builtin()
                .with_configs([&config])
                .unwrap();
            assert_eq!(
                registry.normalize(&config).unwrap().max_output_tokens,
                Some(output)
            );
            assert_eq!(config.max_output_tokens, None);
        }
    }
}

#[test]
fn custom_connections_validate_and_restore_protocol_without_shadowing_builtins() {
    let mut first = ModelProviderConfig::new(provider_id("custom-one"));
    first.custom = Some(CustomProviderConfig {
        context_window: 272_000,
        order: 0,
        model: None,
        name: "One".into(),
        protocol: CustomProviderProtocol::Responses,
    });
    first.base_url = Some("https://one.test/v1".into());
    let encoded = serde_json::to_string(&first).unwrap();
    let restored: ModelProviderConfig = serde_json::from_str(&encoded).unwrap();
    assert_eq!(restored, first);
    let registry = ProviderConfigRegistry::builtin()
        .with_configs([&restored])
        .unwrap();
    assert_eq!(
        registry.normalize(&restored).unwrap().api_profile,
        ApiProfile::OpenAiResponses
    );
    assert_eq!(
        registry.get(&restored.provider).unwrap().api_key_policy,
        ApiKeyPolicy::Optional
    );
    let mut second = first.clone();
    second.provider = provider_id("custom-two");
    assert!(
        ProviderConfigRegistry::builtin()
            .with_configs([&first, &second])
            .is_err()
    );
    second.custom.as_mut().unwrap().name = "Two".into();
    assert!(
        ProviderConfigRegistry::builtin()
            .with_configs([&first, &second])
            .is_ok()
    );
    for url in [
        "invalid",
        "https://user:password@example.test/v1",
        "https://example.test/v1?key=secret",
    ] {
        second.base_url = Some(url.into());
        assert!(second.validate_static().is_err());
    }
    first.provider = provider_id("openai");
    assert!(first.validate_static().is_err());
}

fn definition(id: &str, endpoint: EndpointPolicy) -> ProviderDefinition {
    ProviderDefinition::new(
        provider_id(id),
        format!("{id} provider"),
        ProviderAdapter::OpenAiCompatible,
        ApiProfile::OpenAiChatCompletions,
        endpoint,
        ModelCatalogPolicy::AllowUnlisted,
    )
}

fn model_ref(provider: &str, model: &str) -> ash_protocol::ModelRef {
    ash_protocol::ModelRef::new(
        provider_id(provider),
        ModelId::new(model).expect("test model ID is valid"),
    )
}

#[test]
fn model_provider_config_is_serializable_and_has_a_schema() {
    let config = ModelProviderConfig {
        access_mode: crate::ProviderAccessMode::Api,
        custom: None,
        provider: provider_id("openai"),
        base_url: Some("https://example.test/v1".into()),
        max_output_tokens: Some(2048),
        model_context: BTreeMap::from([(
            ModelId::new("gpt-test").unwrap(),
            ModelContextConfig {
                context_window: 16_384,
                auto_compact_token_limit: Some(12_000),
            },
        )]),
    };

    let value = serde_json::to_value(&config).unwrap();
    assert_eq!(
        value,
        json!({
            "provider": "openai",
            "baseUrl": "https://example.test/v1",
            "maxOutputTokens": 2048,
            "modelContext": {
                "gpt-test": {
                    "contextWindow": 16384,
                    "autoCompactTokenLimit": 12000
                }
            }
        })
    );
    assert_eq!(
        serde_json::from_value::<ModelProviderConfig>(value).unwrap(),
        config
    );

    let schema = serde_json::to_value(model_provider_config_schema()).unwrap();
    assert!(schema["properties"]["provider"].is_object());
    assert!(schema["properties"]["baseUrl"].is_object());
}

#[test]
fn registry_applies_endpoint_and_token_defaults_during_normalization() {
    let registry = ProviderConfigRegistry::from_definitions([definition(
        "custom",
        EndpointPolicy::ProviderDefault {
            base_url: " https://example.test/v1/// ".into(),
        },
    )
    .with_defaults(ProviderDefaults {
        max_output_tokens: Some(1024),
        ..ProviderDefaults::default()
    })])
    .unwrap();

    let normalized = registry
        .normalize(&ModelProviderConfig::new(provider_id("custom")))
        .unwrap();

    assert_eq!(normalized.base_url, "https://example.test/v1");
    assert_eq!(normalized.max_output_tokens, Some(1024));
    assert_eq!(normalized.api_profile, ApiProfile::OpenAiChatCompletions);
}

#[test]
fn builtins_declare_native_streaming_without_inference_from_api_profile() {
    let registry = ProviderConfigRegistry::builtin();
    for provider in registry.providers() {
        assert_eq!(
            provider.output_transport,
            ModelOutputTransport::NativeStreaming,
            "provider {}",
            provider.id,
        );
    }
}

#[test]
fn builtins_declare_websocket_protocol_without_inference_from_http_compatibility() {
    let registry = ProviderConfigRegistry::builtin();
    assert_eq!(
        registry
            .get(&provider_id("openai"))
            .unwrap()
            .websocket_api_profile,
        WebSocketApiProfile::OpenAiResponses,
    );
    for provider in [
        "openai-compatible",
        "anthropic",
        "google",
        "xai",
        "qwen",
        "kimi",
        "deepseek",
        "ollama",
        "huggingface",
        "zai",
        "minimax",
        "mimo",
    ] {
        assert_eq!(
            registry
                .get(&provider_id(provider))
                .unwrap()
                .websocket_api_profile,
            WebSocketApiProfile::Unavailable,
            "provider {provider}",
        );
    }
}

#[test]
fn responses_websocket_requires_the_matching_http_api_profile() {
    let invalid = definition("custom", EndpointPolicy::ConfiguredOnly)
        .with_websocket_api_profile(WebSocketApiProfile::OpenAiResponses);

    assert!(matches!(
        ProviderConfigRegistry::from_definitions([invalid]),
        Err(ProviderConfigError::InvalidProvider { .. })
    ));
}

#[test]
fn token_count_targets_and_model_support_are_normalized_explicitly() {
    let registry = ProviderConfigRegistry::builtin();
    let openai = registry
        .normalize(&ModelProviderConfig {
            access_mode: crate::ProviderAccessMode::Api,
            custom: None,
            provider: provider_id("openai"),
            base_url: Some("https://proxy.test/v1".into()),
            max_output_tokens: None,
            model_context: BTreeMap::new(),
        })
        .unwrap();
    let google = registry
        .normalize(&ModelProviderConfig::new(provider_id("google")))
        .unwrap();
    let google_override = registry
        .normalize(&ModelProviderConfig {
            access_mode: crate::ProviderAccessMode::Api,
            custom: None,
            provider: provider_id("google"),
            base_url: Some("https://proxy.test/v1/openai".into()),
            max_output_tokens: None,
            model_context: BTreeMap::new(),
        })
        .unwrap();
    let kimi = registry
        .normalize(&ModelProviderConfig::new(provider_id("kimi")))
        .unwrap();

    assert_eq!(
        openai.input_token_count.unwrap().base_url,
        "https://proxy.test/v1"
    );
    assert_eq!(
        google.input_token_count.unwrap().base_url,
        "https://generativelanguage.googleapis.com/v1beta"
    );
    assert!(google_override.input_token_count.is_none());
    let kimi = kimi.input_token_count.unwrap();
    assert!(kimi.supports(&ModelId::new("kimi-k2.6").unwrap()));
    assert!(!kimi.supports(&ModelId::new("unlisted-kimi-model").unwrap()));
}

#[test]
fn token_count_definitions_reject_invalid_targets_and_duplicate_models() {
    let invalid_target = definition("invalid-target", EndpointPolicy::ConfiguredOnly)
        .with_input_token_count(InputTokenCountDefinition::provider_default(
            InputTokenCountProfile::GoogleGenerateContent,
            "file:///tmp/tokenizer",
        ));
    let duplicate_models = definition("duplicate-models", EndpointPolicy::ConfiguredOnly)
        .with_input_token_count(
            InputTokenCountDefinition::invocation_base(InputTokenCountProfile::KimiChatCompletions)
                .with_models([ModelId::new("same").unwrap(), ModelId::new("same").unwrap()]),
        );

    assert!(matches!(
        ProviderConfigRegistry::from_definitions([invalid_target]),
        Err(ProviderConfigError::InvalidBaseUrl { .. })
    ));
    assert!(matches!(
        ProviderConfigRegistry::from_definitions([duplicate_models]),
        Err(ProviderConfigError::InvalidProvider { .. })
    ));
}

#[test]
fn automatic_review_uses_the_provider_default_or_active_model() {
    let builtins = ProviderConfigRegistry::builtin();
    assert_eq!(
        builtins
            .automatic_approval_review_model(&model_ref("openai", "gpt-main"))
            .unwrap(),
        model_ref("openai", "gpt-5.6")
    );

    let custom = ProviderConfigRegistry::from_definitions([definition(
        "custom",
        EndpointPolicy::ConfiguredOnly,
    )])
    .unwrap();
    assert_eq!(
        custom
            .automatic_approval_review_model(&model_ref("custom", "local-review-capable"))
            .unwrap(),
        model_ref("custom", "local-review-capable")
    );
}

#[test]
fn explicit_review_model_must_pass_the_static_catalog_gate() {
    let registry = ProviderConfigRegistry::from_definitions([ProviderDefinition::new(
        provider_id("listed"),
        "Listed provider",
        ProviderAdapter::OpenAiCompatible,
        ApiProfile::OpenAiChatCompletions,
        EndpointPolicy::ConfiguredOnly,
        ModelCatalogPolicy::ListedOnly,
    )
    .with_default_model(Model::new(ModelId::new("available").unwrap(), "Available"))])
    .unwrap();

    assert_eq!(
        registry
            .validate_model_selection(&model_ref("listed", "missing"))
            .unwrap_err(),
        ProviderConfigError::ModelNotRegistered {
            provider: provider_id("listed"),
            model: ModelId::new("missing").unwrap(),
        }
    );
}

#[test]
fn builtin_provider_api_key_policies_are_explicit() {
    let registry = ProviderConfigRegistry::builtin();

    assert_eq!(
        registry.get(&provider_id("ollama")).unwrap().api_key_policy,
        ApiKeyPolicy::Unsupported
    );
    assert_eq!(
        registry
            .get(&provider_id("openai-compatible"))
            .unwrap()
            .api_key_policy,
        ApiKeyPolicy::Optional
    );
    assert!(
        registry
            .providers()
            .filter(|provider| provider.id.as_str() != "ollama")
            .any(|provider| provider.api_key_policy == ApiKeyPolicy::Required)
    );
    assert_eq!(
        registry
            .get(&provider_id("anthropic"))
            .unwrap()
            .api_key_header,
        ApiKeyHeader::XApiKey
    );
    assert_eq!(
        registry.get(&provider_id("google")).unwrap().api_key_header,
        ApiKeyHeader::Bearer
    );
    assert_eq!(
        registry.get(&provider_id("openai")).unwrap().api_key_header,
        ApiKeyHeader::Bearer
    );
}

#[test]
fn configured_endpoint_is_required_and_overrides_are_normalized() {
    let registry = ProviderConfigRegistry::from_definitions([definition(
        "custom",
        EndpointPolicy::ConfiguredOnly,
    )])
    .unwrap();
    assert_eq!(
        registry
            .normalize(&ModelProviderConfig::new(provider_id("custom")))
            .unwrap_err(),
        ProviderConfigError::MissingBaseUrl(provider_id("custom"))
    );

    let normalized = registry
        .normalize(&ModelProviderConfig {
            access_mode: crate::ProviderAccessMode::Api,
            custom: None,
            provider: provider_id("custom"),
            base_url: Some(" https://runtime.test/v1/ ".into()),
            max_output_tokens: Some(512),
            model_context: BTreeMap::new(),
        })
        .unwrap();
    assert_eq!(normalized.base_url, "https://runtime.test/v1");
}

#[test]
fn static_validation_rejects_invalid_urls_and_zero_token_limits() {
    let invalid_url = ModelProviderConfig {
        access_mode: crate::ProviderAccessMode::Api,
        custom: None,
        provider: provider_id("custom"),
        base_url: Some("file:///tmp/provider".into()),
        max_output_tokens: None,
        model_context: BTreeMap::new(),
    };
    assert!(matches!(
        invalid_url.validate_static(),
        Err(ProviderConfigError::InvalidBaseUrl { .. })
    ));

    let invalid_tokens = ModelProviderConfig {
        access_mode: crate::ProviderAccessMode::Api,
        custom: None,
        provider: provider_id("custom"),
        base_url: None,
        max_output_tokens: Some(0),
        model_context: BTreeMap::new(),
    };
    assert_eq!(
        invalid_tokens.validate_static().unwrap_err(),
        ProviderConfigError::InvalidMaxOutputTokens(provider_id("custom"))
    );
}

#[test]
fn static_validation_rejects_zero_model_context_limits() {
    let model = ModelId::new("model").unwrap();
    let config = ModelProviderConfig {
        access_mode: crate::ProviderAccessMode::Api,
        custom: None,
        provider: provider_id("custom"),
        base_url: None,
        max_output_tokens: None,
        model_context: BTreeMap::from([(
            model.clone(),
            ModelContextConfig {
                context_window: 0,
                auto_compact_token_limit: None,
            },
        )]),
    };

    assert_eq!(
        config.validate_static().unwrap_err(),
        ProviderConfigError::InvalidModelContext {
            provider: provider_id("custom"),
            model,
        }
    );
}

#[test]
fn registry_merge_has_explicit_conflict_semantics() {
    let mut registry = ProviderConfigRegistry::from_definitions([definition(
        "custom",
        EndpointPolicy::ConfiguredOnly,
    )])
    .unwrap();
    let replacement = definition(
        "custom",
        EndpointPolicy::ProviderDefault {
            base_url: "https://replacement.test/v1".into(),
        },
    );

    assert_eq!(
        registry
            .merge(
                ProviderConfigRegistry::from_definitions([replacement.clone()]).unwrap(),
                RegistryMergePolicy::RejectConflicts,
            )
            .unwrap_err(),
        ProviderConfigError::DuplicateProvider(provider_id("custom"))
    );
    assert_eq!(
        registry.get(&provider_id("custom")).unwrap().endpoint,
        EndpointPolicy::ConfiguredOnly
    );

    registry
        .merge(
            ProviderConfigRegistry::from_definitions([replacement]).unwrap(),
            RegistryMergePolicy::ReplaceExisting,
        )
        .unwrap();
    assert!(matches!(
        registry.get(&provider_id("custom")).unwrap().endpoint,
        EndpointPolicy::ProviderDefault { .. }
    ));
}

#[test]
fn builtins_are_valid_and_include_all_supported_adapters() {
    let registry = ProviderConfigRegistry::builtin();
    assert_eq!(registry.providers().count(), 13);
    assert_eq!(
        registry.get(&provider_id("openai")).unwrap().adapter,
        ProviderAdapter::OpenAi
    );
    assert_eq!(
        registry.get(&provider_id("openai")).unwrap().api_profile,
        ApiProfile::OpenAiResponses
    );
    assert_eq!(
        registry
            .normalize(&ModelProviderConfig::new(provider_id("anthropic")))
            .unwrap()
            .max_output_tokens,
        Some(1024)
    );
}

#[test]
fn static_model_catalog_has_unique_valid_rows() {
    let mut identities = BTreeSet::new();
    for spec in STATIC_MODEL_CATALOG {
        assert!(!spec.provider_id.trim().is_empty());
        assert!(!spec.model_id.trim().is_empty());
        assert!(!spec.display_name.trim().is_empty());
        assert!(identities.insert((
            spec.provider_id,
            spec.model_id,
            spec.access == ash_protocol::ModelAccess::Subscription,
        )));
        assert_eq!(
            spec.has_one_million_context(),
            spec.context_window == ash_protocol::ContextWindow::Known(1_000_000)
        );
        if let Some(effort) = spec.model_reasoning_effort {
            assert!(spec.supported_reasoning_efforts.contains(&effort));
        }
        match spec.access {
            ash_protocol::ModelAccess::Subscription => {
                assert_ne!(spec.runtime, StaticModelRuntime::ProviderApi);
            }
            ash_protocol::ModelAccess::ApiKey => {
                assert_eq!(spec.runtime, StaticModelRuntime::ProviderApi);
            }
            _ => {}
        }
        if let (
            ash_protocol::ContextWindow::Known(context_window),
            Some(auto_compact_token_limit),
        ) = (spec.context_window, spec.auto_compact_token_limit)
        {
            assert!(auto_compact_token_limit <= context_window);
        }
    }
}

#[test]
fn chatgpt_subscription_seeds_only_current_models() {
    let mut config = ModelProviderConfig::new(provider_id("openai"));
    config.access_mode = ProviderAccessMode::Subscription;
    let registry = ProviderConfigRegistry::builtin()
        .with_configs([&config])
        .unwrap();
    let models = &registry.get(&provider_id("openai")).unwrap().models;
    assert_eq!(
        models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]
    );
}

#[test]
fn builtin_provider_models_and_defaults_derive_from_static_catalog() {
    let registry = ProviderConfigRegistry::builtin();

    for definition in registry.providers() {
        let specs = STATIC_MODEL_CATALOG
            .iter()
            .filter(|spec| {
                spec.provider_id == definition.id.as_str()
                    && spec.access != ash_protocol::ModelAccess::Subscription
            })
            .collect::<Vec<_>>();
        assert_eq!(
            definition.models,
            specs.iter().map(|spec| spec.model()).collect::<Vec<_>>()
        );

        let defaults = specs
            .iter()
            .filter(|spec| spec.is_approval_review_default)
            .collect::<Vec<_>>();
        assert!(defaults.len() <= 1);
        match defaults.first() {
            Some(default) => assert_eq!(
                definition.defaults.approval_review_model,
                ApprovalReviewModelDefault::Model {
                    model: ModelId::new(default.model_id).unwrap(),
                }
            ),
            None => assert_eq!(
                definition.defaults.approval_review_model,
                ApprovalReviewModelDefault::ActiveModel
            ),
        }
    }

    for spec in STATIC_MODEL_CATALOG {
        assert!(registry.get(&provider_id(spec.provider_id)).is_some());
        if spec.runtime == StaticModelRuntime::ChatGptSubscription {
            assert_eq!(spec.provider_id, "openai");
            assert!(!spec.is_approval_review_default);
            assert!(!spec.supports_input_token_count);
        }
        if spec.runtime == StaticModelRuntime::KimiCode {
            assert_eq!(spec.provider_id, "kimi");
        }
        if spec.runtime == StaticModelRuntime::ZaiCodingPlan {
            assert_eq!(spec.provider_id, "zai");
            assert!(!spec.is_approval_review_default);
        }
        if spec.supports_input_token_count {
            assert!(
                registry
                    .get(&provider_id(spec.provider_id))
                    .unwrap()
                    .input_token_count
                    .as_ref()
                    .is_some_and(|definition| definition
                        .models
                        .supports(&ModelId::new(spec.model_id).unwrap()))
            );
        }
    }
}

#[test]
fn provider_subscription_mode_replaces_the_api_catalog_and_endpoint() {
    assert_eq!(
        ProviderConfigRegistry::builtin()
            .get(&provider_id("xai"))
            .unwrap()
            .name,
        "xAI"
    );
    for (provider, endpoint, api_key_policy) in [
        (
            "openai",
            "https://chatgpt.com/backend-api/codex",
            ApiKeyPolicy::Unsupported,
        ),
        (
            "xai",
            "https://cli-chat-proxy.grok.com/v1",
            ApiKeyPolicy::Unsupported,
        ),
        (
            "kimi",
            "https://api.kimi.com/coding/v1",
            ApiKeyPolicy::Unsupported,
        ),
        (
            "zai",
            crate::ZAI_CODING_PLAN_BASE_URL,
            ApiKeyPolicy::Required,
        ),
    ] {
        let mut config = ModelProviderConfig::new(provider_id(provider));
        config.access_mode = crate::ProviderAccessMode::Subscription;
        let registry = ProviderConfigRegistry::builtin()
            .with_configs([&config])
            .unwrap();
        let definition = registry.get(&config.provider).unwrap();
        match provider {
            "xai" => assert_eq!(definition.name, "xAI"),
            "zai" => assert_eq!(definition.name, "zai"),
            _ => {}
        }
        assert_eq!(definition.api_key_policy, api_key_policy);
        assert!(
            matches!(&definition.endpoint, EndpointPolicy::ProviderDefault { base_url } if base_url == endpoint)
        );
        assert!(
            definition
                .models
                .iter()
                .all(|model| model.access == ash_protocol::ModelAccess::Subscription)
        );
        assert_eq!(
            registry.normalize(&config).unwrap().access_mode,
            crate::ProviderAccessMode::Subscription
        );
    }
}

#[test]
fn normalization_rejects_a_selected_provider_mismatch() {
    let registry = ProviderConfigRegistry::builtin();
    let error = registry
        .normalize_for(
            &ModelProviderConfig::new(provider_id("openai")),
            &provider_id("anthropic"),
        )
        .unwrap_err();

    assert_eq!(
        error,
        ProviderConfigError::ProviderMismatch {
            configured: provider_id("openai"),
            selected: provider_id("anthropic"),
        }
    );
}

#[test]
fn custom_provider_inherits_compatible_models_or_uses_its_exact_override() {
    let mut config = ModelProviderConfig::new(provider_id("custom-gateway"));
    config.base_url = Some("https://example.invalid/v1".into());
    config.custom = Some(CustomProviderConfig {
        context_window: 272_000,
        order: 1,
        name: "Gateway".into(),
        model: None,
        protocol: CustomProviderProtocol::Responses,
    });
    let registry = ProviderConfigRegistry::builtin()
        .with_configs([&config])
        .unwrap();
    let models = &registry.get(&config.provider).unwrap().models;
    assert!(models.iter().any(|model| model.id.as_str() == "gpt-5.6"));
    assert!(
        !models
            .iter()
            .any(|model| model.id.as_str().starts_with("claude"))
    );
    config.custom.as_mut().unwrap().model = Some(ModelId::new("private-alias").unwrap());
    let registry = ProviderConfigRegistry::builtin()
        .with_configs([&config])
        .unwrap();
    assert!(registry.get(&config.provider).unwrap().models.is_empty());
    assert_eq!(
        registry.get(&config.provider).unwrap().model_catalog_policy,
        ModelCatalogPolicy::AllowUnlisted
    );
}

#[test]
fn realtime_service_requires_an_independent_explicit_capability() {
    let registry = ProviderConfigRegistry::builtin();
    for definition in registry.providers() {
        assert_eq!(
            definition.realtime_api_profile,
            if definition.id.as_str() == "openai" {
                crate::RealtimeApiProfile::OpenAiRealtime
            } else {
                crate::RealtimeApiProfile::Unavailable
            }
        );
    }
    let mut old = serde_json::to_value(registry.get(&provider_id("openai")).unwrap()).unwrap();
    old.as_object_mut().unwrap().remove("realtimeApiProfile");
    let restored: crate::ProviderDefinition = serde_json::from_value(old).unwrap();
    assert_eq!(
        restored.realtime_api_profile,
        crate::RealtimeApiProfile::Unavailable
    );
}
