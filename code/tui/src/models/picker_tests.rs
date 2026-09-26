use super::ModelSelectionAction;
use super::model_choices;
use crate::widgets::list_selection::ListSelectionState;
use ash_app_server_protocol::protocol::config::CustomProviderConfigDto;
use ash_app_server_protocol::protocol::config::CustomProviderProtocolDto;
use ash_app_server_protocol::protocol::config::ModelRefDto;
use ash_app_server_protocol::protocol::config::ProviderConfigDto;
use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
use ash_app_server_protocol::protocol::model::ModelListResult;
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
fn model_picker_shows_name_only_and_keeps_selection_identity_and_pin_state() {
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
    let view = model_choices(&catalog, &config).unwrap();
    let state = ListSelectionState::new(view.model);

    assert_eq!(state.title(), "Model");
    assert!(!state.show_tabs());
    assert!(state.search().is_some());
    assert_eq!(state.visible_items()[0].label(), "Pinned");
    assert_eq!(state.visible_items()[1].label(), "GPT Ash");
    assert_eq!(state.visible_items()[1].description(), None);
    assert_eq!(state.selected_visible_index(), Some(1));
    assert!(view.actions.values().any(|action| {
        action
            == &ModelSelectionAction::Select {
                preference: "openai/gpt-ash".into(),
                pinned: true,
            }
    }));
}

#[test]
fn subscription_models_share_one_list_without_provider_names() {
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
    let view = model_choices(&catalog, &config).unwrap();
    assert_eq!(view.actions.len(), 2);
    let state = ListSelectionState::new(view.model);
    assert!(!state.show_tabs());
    assert_eq!(state.tabs().len(), 1);
    assert_eq!(
        state
            .visible_items()
            .iter()
            .map(|item| (item.label(), item.description()))
            .collect::<Vec<_>>(),
        [("GPT Ash", None), ("Grok Ash", None)]
    );
}

#[test]
fn pinned_models_lead_the_same_searchable_list_without_duplicate_entries() {
    let catalog = ModelListResult {
        models: vec![
            catalog_entry("openai", "gpt-first", "Shared name"),
            catalog_entry("xai", "grok-pinned", "Shared name"),
            catalog_entry("openai", "gpt-last", "Last model"),
        ],
    };
    let mut config = crate::test_support::empty_config_snapshot();
    for provider in ["openai", "xai"] {
        config
            .providers
            .insert(provider.into(), provider_config(provider));
    }
    config.tui.0.insert(
        "pinnedModels".into(),
        serde_json::json!([{"provider":"xai","model":"grok-pinned"}]),
    );
    let view = model_choices(&catalog, &config).unwrap();
    assert_eq!(view.actions.len(), 3);
    let mut state = ListSelectionState::new(view.model);
    assert_eq!(
        state
            .visible_items()
            .iter()
            .map(|item| (item.label(), item.description()))
            .collect::<Vec<_>>(),
        [
            ("Pinned", None),
            ("Shared name", None),
            ("Other models", None),
            ("Shared name", None),
            ("Last model", None),
        ]
    );
    assert_eq!(state.selected_visible_index(), Some(1));
    assert!(state.focus_search());
    state.handle_paste("Last".into());
    assert_eq!(state.visible_items().len(), 1);
    assert_eq!(state.visible_items()[0].label(), "Last model");
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
    let view = model_choices(&catalog, &config).unwrap();
    assert_eq!(view.actions.len(), 1);
    assert_eq!(
        view.actions.values().next(),
        Some(&ModelSelectionAction::Select {
            preference: "mimo/mimo-v2.5-pro".into(),
            pinned: true,
        })
    );
    let state = ListSelectionState::new(view.model);
    assert!(!state.show_tabs());
    assert_eq!(state.tabs().len(), 1);
    assert_eq!(state.visible_items()[0].label(), "Pinned");
    assert_eq!(state.visible_items()[1].label(), "MiMo V2.5 Pro");
    assert_eq!(state.visible_items()[1].description(), None);
}

#[test]
fn model_picker_without_configured_models_explains_configuration() {
    let catalog = ModelListResult {
        models: vec![catalog_entry("openai", "gpt-ash", "GPT Ash")],
    };
    let config = crate::test_support::empty_config_snapshot();
    let view = model_choices(&catalog, &config).unwrap();
    assert!(view.actions.is_empty());
    let state = ListSelectionState::new(view.model);
    assert_eq!(state.tabs().len(), 1);
    assert!(!state.show_tabs());
    assert!(state.visible_items().is_empty());
    assert_eq!(
        state.empty_message(),
        "No configured models · Configure a provider in /config"
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
