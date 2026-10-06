use super::*;
use ash_protocol::CapabilitySupport;
use ash_protocol::ReasoningEffort;
use serde_json::json;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

fn provider_id(value: &str) -> ProviderId {
    ProviderId::new(value).unwrap()
}

#[test]
fn retired_providers_are_absent_from_catalog_connections_and_invocation() {
    let registry = ProviderConfigRegistry::builtin();
    for name in ["qwen", "mimo", "minimax", "huggingface"] {
        let provider = provider_id(name);
        assert!(registry.get(&provider).is_none());
        assert!(
            registry
                .connection(&ModelConnectionId::new(name).unwrap())
                .is_none()
        );
        assert!(
            STATIC_MODEL_CATALOG
                .iter()
                .all(|model| model.provider_id != name)
        );
        assert_eq!(
            registry.normalize(&ModelProviderConfig::new(provider.clone())),
            Err(ProviderConfigError::UnknownProvider(provider))
        );
    }
}

#[test]
fn plugin_model_settings_are_validated_before_registry_commit() {
    let mut provider = definition("plugin", EndpointPolicy::ConfiguredOnly);
    let mut model = ash_protocol::ModelInfo::new(ModelId::new("test").unwrap(), "Test");
    model.settings.tool_output_limit = Some(ash_protocol::ModelToolOutputLimit::Tokens(0));
    provider.models.push(model);
    assert!(ProviderConfigRegistry::from_definitions([provider]).is_err());
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
                model_aliases: Default::default(),
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
        model_aliases: Default::default(),
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
    second.connection = ModelConnectionId::new("custom-two").unwrap();
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
        fast_models: Default::default(),
        connection: ModelConnectionId::new("openai").unwrap(),
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
            "connection": "openai",
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
        "kimi",
        "deepseek",
        "ollama",
        "bigmodel",
        "bigmodel-coding-plan",
        "zai",
        "zai-coding-plan",
    ] {
        assert_eq!(
            registry
                .connection(&ModelConnectionId::new(provider).unwrap())
                .unwrap()
                .transport
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
            fast_models: Default::default(),
            connection: ModelConnectionId::new("openai").unwrap(),
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
            fast_models: Default::default(),
            connection: ModelConnectionId::new("google").unwrap(),
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
        model_ref("openai", "gpt-6-luna")
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

    assert_eq!(registry.get(&provider_id("google")).unwrap().name, "Google");
    assert_eq!(
        registry
            .connection(&ModelConnectionId::new("bigmodel").unwrap())
            .unwrap()
            .transport
            .name,
        "BigModel"
    );
    assert_eq!(registry.get(&provider_id("glm")).unwrap().name, "GLM");

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
            fast_models: Default::default(),
            connection: ModelConnectionId::new("custom").unwrap(),
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
        fast_models: Default::default(),
        connection: ModelConnectionId::new("custom").unwrap(),
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
        fast_models: Default::default(),
        connection: ModelConnectionId::new("custom").unwrap(),
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
        fast_models: Default::default(),
        connection: ModelConnectionId::new("custom").unwrap(),
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
    assert_eq!(registry.providers().count(), 12);
    assert_eq!(registry.connections().len(), 20);
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
fn meta_connection_declares_muse_responses_auth_and_reasoning() {
    let registry = ProviderConfigRegistry::builtin();
    let config = ModelProviderConfig::new(provider_id("meta"));
    let normalized = registry.normalize(&config).unwrap();
    assert_eq!(normalized.base_url, "https://api.meta.ai/v1");
    assert_eq!(normalized.api_profile, ApiProfile::OpenAiResponses);
    let connection = builtin_connections()
        .into_iter()
        .find(|entry| entry.id.as_str() == "meta")
        .unwrap();
    assert_eq!(connection.transport.api_key_policy, ApiKeyPolicy::Required);
    assert_eq!(connection.runtime, ModelConnectionRuntime::ProviderApi);
    let model = find_static_model(&ash_protocol::ModelRef::new(
        provider_id("meta"),
        ModelId::new("muse-spark-1.3").unwrap(),
    ))
    .unwrap();
    assert_eq!(
        model.context_window,
        ash_protocol::ContextWindow::Known(1_048_576)
    );
    assert!(
        model
            .supported_reasoning_efforts
            .contains(&ReasoningEffort::Minimal)
    );
    assert!(
        !model
            .supported_reasoning_efforts
            .contains(&ReasoningEffort::None)
    );
}

#[test]
fn static_model_catalog_has_unique_valid_rows() {
    let mut identities = BTreeSet::new();
    for spec in STATIC_MODEL_CATALOG.iter() {
        assert!(identities.insert((&spec.provider_id, &spec.model_id)));
        assert_eq!(find_static_model(&spec.model_ref()), Some(spec));
        if let Some(effort) = spec.model_reasoning_effort {
            assert!(spec.supported_reasoning_efforts.contains(&effort));
        }
    }
}

#[test]
fn static_catalog_exposes_only_model_specific_reasoning_levels() {
    let cases: &[(&str, &str, &[ReasoningEffort])] = &[
        (
            "openai",
            "gpt-6.1-sol",
            &[
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
                ReasoningEffort::ExtraHigh,
                ReasoningEffort::Max,
            ],
        ),
        (
            "openai",
            "gpt-6-sol",
            &[
                ReasoningEffort::None,
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
                ReasoningEffort::ExtraHigh,
                ReasoningEffort::Max,
            ],
        ),
        (
            "anthropic",
            "claude-opus-5-5",
            &[
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
                ReasoningEffort::Max,
            ],
        ),
        (
            "google",
            "gemini-3.6-flash",
            &[
                ReasoningEffort::Minimal,
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
            ],
        ),
        (
            "xai",
            "grok-4.7",
            &[
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
                ReasoningEffort::ExtraHigh,
            ],
        ),
        (
            "kimi",
            "kimi-k3",
            &[
                ReasoningEffort::Low,
                ReasoningEffort::High,
                ReasoningEffort::Max,
            ],
        ),
        (
            "deepseek",
            "deepseek-v4-pro",
            &[
                ReasoningEffort::None,
                ReasoningEffort::Low,
                ReasoningEffort::High,
                ReasoningEffort::Max,
            ],
        ),
        (
            "glm",
            "glm-5.2",
            &[
                ReasoningEffort::None,
                ReasoningEffort::Minimal,
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
                ReasoningEffort::ExtraHigh,
                ReasoningEffort::Max,
            ],
        ),
        ("anthropic", "claude-haiku-4-5-20251001", &[]),
    ];
    for &(provider, model, expected) in cases {
        let entry = STATIC_MODEL_CATALOG
            .iter()
            .find(|entry| entry.provider_id == provider && entry.model_id == model)
            .unwrap_or_else(|| panic!("missing catalog model {provider}/{model}"));
        assert_eq!(
            entry.supported_reasoning_efforts, expected,
            "{provider}/{model}"
        );
        if !expected.is_empty() {
            assert_eq!(
                entry.model().capabilities.reasoning,
                CapabilitySupport::Supported
            );
        }
    }
}

#[test]
fn switching_connections_preserves_the_model_catalog() {
    let mut vendors = BTreeMap::new();
    for connection in builtin_connections() {
        connection.transport.validate().unwrap();
        if matches!(connection.id.as_str(), "kimi-desktop" | "kimi-cli") {
            assert_eq!(
                connection.transport.model_catalog_policy,
                ModelCatalogPolicy::AllowUnlisted
            );
            assert!(connection.transport.models.is_empty());
        }
        let mut config = ModelProviderConfig::for_connection(connection.id.clone());
        if connection.transport.endpoint == EndpointPolicy::ConfiguredOnly {
            config.base_url = Some("https://example.com/v1".into());
        }
        let registry = ProviderConfigRegistry::builtin()
            .with_configs([&config])
            .unwrap();
        let actual = &registry.get(&config.provider).unwrap().models;
        if !matches!(connection.id.as_str(), "kimi-desktop" | "kimi-cli")
            && let Some(previous) = vendors.insert(config.provider.clone(), actual.clone())
        {
            assert_eq!(
                actual, &previous,
                "{} changed model identity",
                connection.id
            );
        }
        assert_eq!(
            registry.normalize(&config).unwrap().access_mode,
            connection.access_mode
        );
    }
}

#[test]
fn kimi_desktop_connection_rejects_endpoint_override() {
    for id in ["kimi-desktop", "kimi-cli"] {
        let mut config =
            ModelProviderConfig::for_connection(crate::ModelConnectionId::new(id).unwrap());
        config.base_url = Some("https://example.test/coding/v1".into());
        assert!(matches!(
            ProviderConfigRegistry::builtin().normalize(&config),
            Err(ProviderConfigError::InvalidBaseUrl { .. })
        ));
    }
}

#[test]
fn builtin_catalog_includes_current_chat_model_families() {
    let registry = ProviderConfigRegistry::builtin();
    for (provider, model) in [
        ("openai", "gpt-6.1-sol"),
        ("openai", "gpt-6-sol"),
        ("openai", "gpt-5.6-terra"),
        ("anthropic", "claude-opus-5-5"),
        ("anthropic", "claude-sonnet-5-5"),
        ("anthropic", "claude-sonnet-5"),
        ("google", "gemini-3.8-flash"),
        ("google", "gemini-3.1-pro-preview"),
        ("xai", "grok-4.7"),
        ("kimi", "kimi-k3"),
        ("deepseek", "deepseek-flash"),
        ("glm", "glm-5.3"),
        ("glm", "glm-5.2"),
    ] {
        assert!(
            registry
                .get(&provider_id(provider))
                .unwrap()
                .models
                .iter()
                .any(|candidate| candidate.id.as_str() == model),
            "missing {provider}/{model}"
        );
    }
    for (provider, model) in [
        ("openai", "gpt-5.4"),
        ("openai", "gpt-5.4-mini"),
        ("openai", "gpt-5.3-codex"),
        ("openai", "gpt-4o"),
        ("google", "gemini-3.5-flash"),
        ("google", "gemini-3.5-flash-lite"),
        ("google", "gemini-3-flash-preview"),
        ("anthropic", "claude-sonnet-4-20250514"),
        ("deepseek", "deepseek-v4-flash"),
    ] {
        assert!(
            registry
                .get(&provider_id(provider))
                .unwrap()
                .models
                .iter()
                .all(|candidate| candidate.id.as_str() != model),
            "retired {provider}/{model} remains listed"
        );
    }
}

#[test]
fn connections_own_endpoints_credentials_and_counting() {
    let connections = builtin_connections();
    let glm = connections
        .iter()
        .filter(|connection| connection.provider.as_str() == "glm")
        .collect::<Vec<_>>();
    assert_eq!(glm.len(), 6);
    let ids = glm
        .iter()
        .map(|connection| &connection.id)
        .collect::<BTreeSet<_>>();
    assert_eq!(ids.len(), 6);
    for connection in glm {
        assert!(
            connection
                .transport
                .models
                .iter()
                .any(|model| model.id.as_str() == "glm-5.3")
        );
        let mut config = ModelProviderConfig::for_connection(connection.id.clone());
        if connection.transport.endpoint == EndpointPolicy::ConfiguredOnly {
            config.base_url = Some("https://example.com/v1".into());
        }
        let registry = ProviderConfigRegistry::builtin()
            .with_configs([&config])
            .unwrap();
        let normalized = registry.normalize(&config).unwrap();
        assert_eq!(normalized.connection, connection.id);
        assert_eq!(normalized.provider.as_str(), "glm");
        if connection.id.as_str().ends_with("start-plan") {
            assert_eq!(config.access_mode(), ProviderAccessMode::Subscription);
            assert_eq!(normalized.api_profile, ApiProfile::AnthropicMessages);
            assert!(normalized.input_token_count.is_none());
            assert_eq!(
                connection.transport.api_key_policy,
                crate::ApiKeyPolicy::Unsupported
            );
            continue;
        }
        assert_eq!(
            normalized
                .input_token_count
                .unwrap()
                .models
                .supports(&ModelId::new("glm-5.3").unwrap()),
            connection.id.as_str() != "bigmodel-coding-plan"
        );
    }
    assert_eq!(
        connections
            .iter()
            .find(|value| value.id.as_str() == "chatgpt-subscription")
            .unwrap()
            .transport
            .api_key_policy,
        ApiKeyPolicy::Unsupported
    );
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
        model_aliases: Default::default(),
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

#[test]
fn transcription_protocol_is_explicit_for_each_direct_api_provider() {
    let registry = ProviderConfigRegistry::builtin();
    for definition in registry.providers() {
        let expected = match definition.id.as_str() {
            "openai" => crate::TranscriptionApiProfile::OpenAiRealtime,
            "xai" => crate::TranscriptionApiProfile::XaiStt,
            _ => crate::TranscriptionApiProfile::Unavailable,
        };
        assert_eq!(
            definition.transcription_api_profile, expected,
            "{}",
            definition.id
        );
    }
    let mut old = serde_json::to_value(registry.get(&provider_id("xai")).unwrap()).unwrap();
    old.as_object_mut()
        .unwrap()
        .remove("transcriptionApiProfile");
    let restored: crate::ProviderDefinition = serde_json::from_value(old).unwrap();
    assert_eq!(
        restored.transcription_api_profile,
        crate::TranscriptionApiProfile::Unavailable
    );
}

#[test]
fn fast_models_are_persisted_per_connection_and_validated_against_model_support() {
    for model in [
        "gpt-6-astra",
        "gpt-6.1-sol",
        "gpt-6-sol",
        "gpt-6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.6",
    ] {
        let model = crate::find_static_model(&model_ref("openai", model)).unwrap();
        assert_eq!(
            model.capabilities.fast_mode,
            ash_protocol::CapabilitySupport::Supported
        );
        assert_eq!(
            model.context_window,
            ash_protocol::ContextWindow::Known(1_050_000)
        );
    }
    let mut config = ModelProviderConfig::new(ProviderId::new("openai").unwrap());
    config
        .fast_models
        .insert(ModelId::new("gpt-6-astra").unwrap());
    config.validate_static().unwrap();
    let encoded = serde_json::to_value(&config).unwrap();
    assert_eq!(encoded["fastModels"], serde_json::json!(["gpt-6-astra"]));
    assert_eq!(
        serde_json::from_value::<ModelProviderConfig>(encoded).unwrap(),
        config
    );
    let normalized = ProviderConfigRegistry::builtin()
        .normalize(&config)
        .unwrap();
    assert_eq!(normalized.fast_models, config.fast_models);
    config.fast_models.insert(ModelId::new("gpt-4o").unwrap());
    assert!(config.validate_static().is_err());
    let mut other = ModelProviderConfig::new(ProviderId::new("deepseek").unwrap());
    other
        .fast_models
        .insert(ModelId::new("deepseek-v4-pro").unwrap());
    assert!(other.validate_static().is_err());
}

#[test]
fn fast_modes_use_the_selected_connection_and_upstream_model_contract() {
    use ash_protocol::CapabilitySupport;
    use ash_protocol::ModelConnectionId;
    for (connection, model, expected_upstream) in [
        ("anthropic", "claude-opus-5-5", "claude-opus-5-5"),
        ("anthropic", "claude-opus-4-7", "claude-opus-4-7"),
        ("anthropic", "claude-sonnet-4-6", "claude-sonnet-4-6"),
        ("google", "gemini-3.8-flash", "gemini-3.8-flash"),
        ("xai", "grok-4.7", "grok-4.7"),
        (
            "kimi-subscription",
            "kimi-k2.7-code",
            "kimi-for-coding-highspeed",
        ),
    ] {
        let mut config =
            ModelProviderConfig::for_connection(ModelConnectionId::new(connection).unwrap());
        let id = ModelId::new(model).unwrap();
        assert_eq!(config.fast_mode_support(&id), CapabilitySupport::Supported);
        config.fast_models.insert(id);
        let normalized = ProviderConfigRegistry::builtin()
            .normalize(&config)
            .unwrap();
        assert_eq!(normalized.upstream_model(model), expected_upstream);
        let encoded = serde_json::to_value(&config).unwrap();
        assert_eq!(
            serde_json::from_value::<ModelProviderConfig>(encoded).unwrap(),
            config
        );
        config.fast_models.clear();
        let normalized = ProviderConfigRegistry::builtin()
            .normalize(&config)
            .unwrap();
        assert_eq!(
            normalized.upstream_model(model),
            if connection == "kimi-subscription" {
                "kimi-for-coding"
            } else {
                model
            }
        );
    }
    for (connection, model) in [
        ("xai-subscription", "grok-4.7"),
        ("kimi", "kimi-k2.7-code"),
        ("anthropic", "claude-fable-5-1"),
        ("deepseek", "deepseek-v4-pro"),
        ("glm", "glm-5.3"),
    ] {
        let mut config =
            ModelProviderConfig::for_connection(ModelConnectionId::new(connection).unwrap());
        config.fast_models.insert(ModelId::new(model).unwrap());
        assert!(config.validate_static().is_err(), "{connection}/{model}");
    }
}

#[test]
fn one_million_context_models_include_other_vendors_without_widening_smaller_models() {
    for (provider, model, window) in [
        ("anthropic", "claude-fable-5-1", 1_000_000),
        ("anthropic", "claude-opus-5-5", 1_000_000),
        ("anthropic", "claude-sonnet-5", 1_000_000),
        ("anthropic", "claude-opus-4-8", 1_000_000),
        ("anthropic", "claude-opus-4-7", 1_000_000),
        ("anthropic", "claude-opus-4-6", 1_000_000),
        ("anthropic", "claude-sonnet-4-6", 1_000_000),
        ("anthropic", "claude-haiku-4-5-20251001", 200_000),
        ("anthropic", "claude-sonnet-4-5-20250929", 200_000),
        ("xai", "grok-4.7", 500_000),
        ("xai", "grok-4.6", 500_000),
        ("xai", "grok-4.5", 500_000),
        ("deepseek", "deepseek-v4-pro", 1_000_000),
        ("glm", "glm-5.3", 1_000_000),
        ("glm", "glm-5.3-flash", 1_000_000),
        ("glm", "glm-5.3-flashx", 1_000_000),
        ("glm", "glm-5.2", 1_000_000),
    ] {
        assert_eq!(
            crate::find_static_model(&model_ref(provider, model))
                .unwrap()
                .context_window,
            ash_protocol::ContextWindow::Known(window)
        );
    }
    for model in crate::STATIC_MODEL_CATALOG
        .iter()
        .filter(|model| model.provider_id == "google")
    {
        assert_eq!(
            model.context_window,
            ash_protocol::ContextWindow::Known(1_048_576)
        );
        assert_eq!(
            model.capabilities.fast_mode,
            ash_protocol::CapabilitySupport::Supported
        );
    }
}

#[test]
fn product_catalog_groups_releases_newest_first() {
    for (provider, latest) in [
        ("openai", "gpt-6.1-sol"),
        ("anthropic", "claude-sonnet-5-5"),
        ("google", "gemini-3.8-flash"),
    ] {
        assert_eq!(
            crate::STATIC_MODEL_CATALOG
                .iter()
                .find(|model| model.provider_id == provider)
                .unwrap()
                .model_id,
            latest
        );
    }
}

#[test]
fn custom_model_aliases_resolve_once_and_keep_the_local_context_declaration() {
    let mut config = ModelProviderConfig::new(provider_id("custom-alias"));
    config.base_url = Some("https://example.test/v1".into());
    config.custom = Some(CustomProviderConfig {
        context_window: 272_000,
        order: 0,
        model: None,
        name: "Alias gateway".into(),
        protocol: CustomProviderProtocol::ChatCompletions,
        model_aliases: BTreeMap::from([
            (
                ModelId::new("local-id").unwrap(),
                ModelId::new("wire-id").unwrap(),
            ),
            (
                ModelId::new("wire-id").unwrap(),
                ModelId::new("other-id").unwrap(),
            ),
        ]),
    });
    config.model_context.insert(
        ModelId::new("local-id").unwrap(),
        ModelContextConfig {
            context_window: 128_000,
            auto_compact_token_limit: None,
        },
    );
    let encoded = serde_json::to_value(&config).unwrap();
    let decoded: ModelProviderConfig = serde_json::from_value(encoded.clone()).unwrap();
    assert_eq!(decoded, config);
    assert_eq!(encoded["custom"]["modelAliases"]["local-id"], "wire-id");
    let registry = ProviderConfigRegistry::builtin()
        .with_configs([&decoded])
        .unwrap();
    let normalized = registry.normalize(&decoded).unwrap();
    assert_eq!(normalized.upstream_model("local-id"), "wire-id");
    assert_eq!(normalized.upstream_model("wire-id"), "other-id");
    assert_eq!(normalized.upstream_model("unlisted-id"), "unlisted-id");
    assert_eq!(
        decoded.model_context[&ModelId::new("local-id").unwrap()].context_window,
        128_000
    );
}
