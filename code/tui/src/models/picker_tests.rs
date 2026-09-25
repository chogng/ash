use super::ModelSelectionAction;
use super::model_choices;
use crate::widgets::list_selection::ListSelectionState;
use ash_app_server_protocol::protocol::config::CustomProviderConfigDto;
use ash_app_server_protocol::protocol::config::CustomProviderProtocolDto;
use ash_app_server_protocol::protocol::config::ModelRefDto;
use ash_app_server_protocol::protocol::config::ProviderConfigDto;
use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
use ash_app_server_protocol::protocol::model::ModelListResult;
use ash_app_server_protocol::protocol::provider::ProviderApiKeyPolicyDto;
use ash_app_server_protocol::protocol::provider::ProviderCatalogEntryDto;
use ash_app_server_protocol::protocol::provider::ProviderListResult;
use ash_protocol::ModelAccess;
use ash_protocol::ModelId;
use ash_protocol::ModelInfo;
use ash_protocol::ModelOutputTransport;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;

fn catalog_entry(provider: &str, model: &str, name: &str) -> ModelCatalogEntry {
    let model = ModelRef::new(
        ProviderId::new(provider).unwrap(),
        ModelId::new(model).unwrap(),
    );
    let mut info = ModelInfo::new(model.model.clone(), name);
    info.access = ModelAccess::ApiKey;
    ModelCatalogEntry::from_info(model, &info, ModelOutputTransport::Unary)
}

fn provider_config(provider: &str) -> ProviderConfigDto {
    ProviderConfigDto {
        provider: provider.into(),
        custom: None,
        base_url: None,
        max_output_tokens: None,
        model_context: Default::default(),
    }
}

#[test]
fn model_picker_shows_names_only_and_keeps_selection_identity_and_pin_state() {
    let catalog = ModelListResult {
        models: vec![catalog_entry("openai", "gpt-ash", "GPT Ash")],
    };
    let model = ModelRefDto {
        provider: "openai".into(),
        model: "gpt-ash".into(),
    };

    let mut config = crate::test_support::empty_config_snapshot();
    config.model = Some(model.clone());
    config
        .providers
        .insert("openai".into(), provider_config("openai"));
    config
        .tui
        .0
        .insert("pinnedModels".into(), serde_json::json!([model]));
    let view = model_choices(&catalog, &config, &ProviderListResult { providers: vec![] }).unwrap();
    let state = ListSelectionState::new(view.model);

    assert_eq!(state.title(), "Model");
    assert!(state.search().is_none());
    assert_eq!(state.visible_items()[0].label(), "GPT Ash");
    assert_eq!(state.visible_items()[0].description(), None);
    assert_eq!(state.selected_visible_index(), Some(0));
    assert!(view.actions.values().any(|action| {
        action
            == &ModelSelectionAction::Select {
                preference: "openai/gpt-ash".into(),
                pinned: true,
            }
    }));
}

#[test]
fn subscription_models_use_chatgpt_and_xai_provider_tabs() {
    let mut chatgpt = catalog_entry("openai", "gpt-ash", "GPT Ash");
    chatgpt.access = ModelAccess::Subscription;
    let mut xai = catalog_entry("xai", "grok-ash", "Grok Ash");
    xai.access = ModelAccess::Subscription;
    let catalog = ModelListResult {
        models: vec![chatgpt, xai],
    };
    let mut config = crate::test_support::empty_config_snapshot();
    for provider in ["openai", "xai"] {
        config
            .providers
            .insert(provider.into(), provider_config(provider));
    }
    let providers = ProviderListResult {
        providers: [("openai", "OpenAI"), ("xai", "xAI")]
            .into_iter()
            .map(|(provider, display_name)| ProviderCatalogEntryDto {
                provider: provider.into(),
                display_name: display_name.into(),
                api_key_policy: ProviderApiKeyPolicyDto::Unsupported,
                api_key_configured: false,
            })
            .collect(),
    };

    let view = model_choices(&catalog, &config, &providers).unwrap();
    assert_eq!(view.actions.len(), 2);
    let state = ListSelectionState::new(view.model);
    assert_eq!(
        state
            .tabs()
            .iter()
            .map(|tab| tab.label())
            .collect::<Vec<_>>(),
        ["Favorites", "ChatGPT", "xAI"]
    );
}

#[test]
fn model_picker_only_offers_models_from_configured_providers() {
    let catalog = ModelListResult {
        models: vec![
            catalog_entry("openai", "gpt-ash", "GPT Ash"),
            catalog_entry("mimo", "mimo-v2.5-pro", "MiMo V2.5 Pro"),
        ],
    };
    let mut config = crate::test_support::empty_config_snapshot();
    config
        .providers
        .insert("mimo".into(), provider_config("mimo"));
    config.providers.insert(
        "custom-empty".into(),
        ProviderConfigDto {
            provider: "custom-empty".into(),
            custom: Some(CustomProviderConfigDto {
                context_window: 100_000,
                order: 1,
                name: "Empty gateway".into(),
                model: None,
                protocol: CustomProviderProtocolDto::Responses,
            }),
            ..provider_config("custom-empty")
        },
    );
    config.tui.0.insert(
        "pinnedModels".into(),
        serde_json::json!([
            {"provider":"openai","model":"gpt-ash"},
            {"provider":"mimo","model":"mimo-v2.5-pro"}
        ]),
    );
    let providers = ProviderListResult {
        providers: vec![
            ProviderCatalogEntryDto {
                provider: "openai".into(),
                display_name: "OpenAI".into(),
                api_key_policy: ProviderApiKeyPolicyDto::Required,
                api_key_configured: false,
            },
            ProviderCatalogEntryDto {
                provider: "mimo".into(),
                display_name: "Xiaomi MiMo".into(),
                api_key_policy: ProviderApiKeyPolicyDto::Required,
                api_key_configured: true,
            },
        ],
    };

    let view = model_choices(&catalog, &config, &providers).unwrap();
    assert_eq!(view.actions.len(), 1);
    assert_eq!(
        view.actions.values().next(),
        Some(&ModelSelectionAction::Select {
            preference: "mimo/mimo-v2.5-pro".into(),
            pinned: true,
        })
    );
    let state = ListSelectionState::new(view.model);
    assert_eq!(
        state
            .tabs()
            .iter()
            .map(|tab| tab.label())
            .collect::<Vec<_>>(),
        ["Favorites", "Xiaomi MiMo"]
    );
    assert_eq!(state.visible_items()[0].label(), "MiMo V2.5 Pro");
}

#[test]
fn model_picker_without_discovered_models_explains_manual_selection() {
    let catalog = ModelListResult {
        models: vec![catalog_entry("openai", "gpt-ash", "GPT Ash")],
    };
    let config = crate::test_support::empty_config_snapshot();
    let view = model_choices(&catalog, &config, &ProviderListResult { providers: vec![] }).unwrap();
    assert!(view.actions.is_empty());
    let state = ListSelectionState::new(view.model);
    assert_eq!(state.tabs().len(), 1);
    assert!(state.visible_items().is_empty());
    assert_eq!(
        state.empty_message(),
        "No discovered models · Use /model provider/model or /config"
    );
}

#[test]
fn malformed_or_duplicate_pins_are_rejected() {
    let mut tui = ash_app_server_protocol::protocol::config::FrontendConfigDto::default();
    for value in [
        serde_json::json!("bad"),
        serde_json::json!([{"provider":"openai","model":"gpt-x"},{"provider":"openai","model":"gpt-x"}]),
    ] {
        tui.0.insert("pinnedModels".into(), value);
        assert!(super::pinned_models(&tui).is_err());
    }
}
