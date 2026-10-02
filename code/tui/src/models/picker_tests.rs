use super::ModelPickerData;
use super::ModelSelectionAction;
use super::model_choices;
use crate::widgets::list_selection::ListSelectionState;
use crate::widgets::list_selection::draw_body_with_pointer;
use ash_app_server_protocol::protocol::config::CustomProviderConfigDto;
use ash_app_server_protocol::protocol::config::CustomProviderProtocolDto;
use ash_app_server_protocol::protocol::config::ModelRefDto;
use ash_app_server_protocol::protocol::config::ProviderConfigDto;
use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
use ash_app_server_protocol::protocol::model::ModelListResult;
use ash_protocol::ModelAccess;
use ash_protocol::ModelId;
use ash_protocol::ModelInfo;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use unicode_width::UnicodeWidthStr;

fn catalog_entry(provider: &str, model: &str, name: &str) -> ModelCatalogEntry {
    let model = ModelRef::new(
        ProviderId::new(provider).unwrap(),
        ModelId::new(model).unwrap(),
    );
    let mut info = ModelInfo::new(model.model.clone(), name);
    info.access = ModelAccess::ApiKey;
    ModelCatalogEntry::from_info(model, &info)
}

fn provider_config(provider: &str) -> ProviderConfigDto {
    ProviderConfigDto {
        connection: provider.into(),
        provider: provider.into(),
        custom: None,
        base_url: None,
        max_output_tokens: None,
        model_context: Default::default(),
    }
}

#[test]
fn fixed_models_remain_available_when_connections_change() {
    let catalog = ModelListResult {
        models: vec![catalog_entry("openai", "gpt-ash", "GPT Ash")],
    };
    let mut data = ModelPickerData::new(catalog, crate::test_support::empty_config_snapshot());
    assert_eq!(data.choices().unwrap().actions.len(), 1);

    let mut config = crate::test_support::empty_config_snapshot();
    config
        .connections
        .insert("kimi-desktop".into(), provider_config("kimi-desktop"));
    data.update_config(config);
    let choices = data.choices().unwrap();
    assert_eq!(choices.actions.len(), 1);
    let state = ListSelectionState::new(choices.model);
    assert_eq!(state.visible_items()[0].label(), "GPT Ash");
}

#[test]
fn model_without_effort_shows_name_only_and_keeps_selection_identity_and_pin_state() {
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
    assert!(view.actions.values().any(|action| matches!(
        action,
        ModelSelectionAction::Select { preference, pinned: true, .. }
            if preference == "openai/gpt-ash"
    )));
}

#[test]
fn subscription_models_share_one_list_without_provider_names() {
    let chatgpt = catalog_entry("openai", "gpt-ash", "GPT Ash");
    let xai = catalog_entry("xai", "grok-ash", "Grok Ash");
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
fn model_picker_keeps_all_builtin_models_selectable_before_configuration() {
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
            connection: "custom-empty".into(),
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
    assert_eq!(view.actions.len(), 2);
    assert!(view.actions.values().any(|action| matches!(action, ModelSelectionAction::Select {preference, pinned: true, ..} if preference == "openai/gpt-ash")));
    let state = ListSelectionState::new(view.model);
    assert!(!state.show_tabs());
    assert_eq!(state.tabs().len(), 1);
    assert_eq!(state.visible_items()[0].label(), "Pinned");
    assert_eq!(state.visible_items()[1].label(), "GPT Ash");
    assert_eq!(state.visible_items()[1].description(), None);
}

#[test]
fn model_picker_without_configured_connections_still_offers_builtin_models() {
    let catalog = ModelListResult {
        models: vec![catalog_entry("openai", "gpt-ash", "GPT Ash")],
    };
    let view = model_choices(&catalog, &crate::test_support::empty_config_snapshot()).unwrap();
    assert_eq!(view.actions.len(), 1);
    let state = ListSelectionState::new(view.model);
    assert_eq!(state.visible_items()[0].label(), "GPT Ash");
    assert!(state.visible_items()[0].id().is_some());
}

#[test]
fn effort_values_do_not_change_model_name_search() {
    let mut entry = catalog_entry("openai", "gpt-ash", "GPT Ash");
    entry.supported_reasoning_efforts = vec![
        ash_protocol::ReasoningEffort::Low,
        ash_protocol::ReasoningEffort::High,
    ];
    entry.model_reasoning_effort = Some(ash_protocol::ReasoningEffort::High);
    let choices = model_choices(
        &ModelListResult {
            models: vec![entry],
        },
        &crate::test_support::empty_config_snapshot(),
    )
    .unwrap();
    let mut state = ListSelectionState::new(choices.model);
    assert_eq!(state.visible_items()[0].description(), None);
    assert!(state.focus_search());
    state.handle_paste("high".into());
    assert!(state.visible_items().is_empty());
}

#[test]
fn effort_labels_align_across_models_with_different_level_counts() {
    use ash_protocol::ReasoningEffort;

    let mut entries = [
        catalog_entry("openai", "terra", "GPT-5.6 Terra"),
        catalog_entry("openai", "luna", "GPT-5.6 Luna"),
        catalog_entry("openai", "mini", "GPT-5 Mini"),
    ];
    entries[0].supported_reasoning_efforts = vec![
        ReasoningEffort::Low,
        ReasoningEffort::Medium,
        ReasoningEffort::High,
    ];
    entries[0].model_reasoning_effort = Some(ReasoningEffort::Medium);
    entries[1].supported_reasoning_efforts = vec![
        ReasoningEffort::Minimal,
        ReasoningEffort::Low,
        ReasoningEffort::Medium,
        ReasoningEffort::High,
        ReasoningEffort::ExtraHigh,
    ];
    entries[1].model_reasoning_effort = Some(ReasoningEffort::Medium);
    entries[2].supported_reasoning_efforts = vec![ReasoningEffort::None];
    entries[2].model_reasoning_effort = Some(ReasoningEffort::None);
    let choices = model_choices(
        &ModelListResult {
            models: entries.into(),
        },
        &crate::test_support::empty_config_snapshot(),
    )
    .unwrap();
    let view = ListSelectionState::new(choices.model);
    let mut terminal = Terminal::new(TestBackend::new(62, 9)).unwrap();
    terminal
        .draw(|frame| {
            draw_body_with_pointer(
                frame,
                frame.area(),
                &view,
                None,
                None,
                crate::render::test_context(),
            )
        })
        .unwrap();
    let buffer = terminal.backend().buffer();
    assert!(
        (0..62).all(|x| buffer[(x, 3)].bg == buffer[(x, 4)].bg),
        "the selected model keeps the list background"
    );
    assert_eq!(buffer[(0, 3)].fg, crate::render::test_context().focus());
    let rendered = terminal.backend().to_string();
    let value_columns = rendered
        .lines()
        .filter_map(|line| {
            ["Medium", "None"]
                .iter()
                .find_map(|value| line.find(value).map(|index| line[..index].width()))
        })
        .collect::<Vec<_>>();
    assert_eq!(value_columns.len(), 3);
    assert!(
        value_columns
            .iter()
            .all(|column| *column == value_columns[0])
    );
    crate::tui_assert_snapshot!("aligned_model_effort_labels", rendered);
}

#[test]
fn configured_model_is_selected_when_picker_opens() {
    let catalog = ModelListResult {
        models: vec![
            catalog_entry("openai", "gpt-first", "First"),
            catalog_entry("openai", "gpt-second", "Second"),
        ],
    };
    let mut config = crate::test_support::empty_config_snapshot();
    config.model = Some(ModelRefDto {
        provider: "openai".into(),
        model: "gpt-second".into(),
    });
    let choices = model_choices(&catalog, &config).unwrap();
    let state = ListSelectionState::new(choices.model);
    assert_eq!(state.selected_item().unwrap().label(), "Second");
}

#[test]
fn model_hints_follow_selected_pin_state_capabilities_and_search_focus() {
    use crate::widgets::list_selection::ListSelection;
    use crate::widgets::list_selection::ListSelectionOutcome;
    use crossterm::event::KeyCode;
    use crossterm::event::KeyEvent;
    use crossterm::event::KeyModifiers;

    let mut adjustable = catalog_entry("openai", "adjustable", "Adjustable");
    adjustable.supported_reasoning_efforts = vec![
        ash_protocol::ReasoningEffort::Low,
        ash_protocol::ReasoningEffort::High,
    ];
    let catalog = ModelListResult {
        models: vec![adjustable, catalog_entry("openai", "simple", "Simple")],
    };
    for pinned in [false, true] {
        let mut config = crate::test_support::empty_config_snapshot();
        if pinned {
            config.tui.0.insert(
                "pinnedModels".into(),
                serde_json::json!([
                    {"provider":"openai", "model":"adjustable"},
                    {"provider":"openai", "model":"simple"}
                ]),
            );
        }
        let choices = model_choices(&catalog, &config).unwrap();
        let mut picker = ListSelection::new(choices.model, choices.actions);
        for (model, supports_effort) in [("adjustable", true), ("simple", false)] {
            let hints = picker.model_key_hints().text();
            assert!(hints.contains(if pinned { "p unpin" } else { "p pin" }));
            assert!(!hints.contains(if pinned { "p pin" } else { "p unpin" }));
            assert_eq!(hints.contains("←→ adjust"), supports_effort);
            assert_eq!(
                picker.handle_model_key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::NONE)),
                ListSelectionOutcome::Activate(ModelSelectionAction::Pin {
                    preference: format!("openai/{model}"),
                    pinned: !pinned,
                })
            );
            picker.handle_model_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        }
        picker.handle_model_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));
        assert!(!picker.model_key_hints().text().contains("p pin"));
        assert!(!picker.model_key_hints().text().contains("p unpin"));
        assert!(!picker.model_key_hints().text().contains("←→ adjust"));
        assert_eq!(
            picker.handle_model_key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::NONE)),
            ListSelectionOutcome::Consumed
        );
        assert_eq!(picker.state().query(), "p");
    }
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
