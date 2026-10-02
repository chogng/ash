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
        fast_models: Default::default(),
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
            ["Medium"]
                .iter()
                .find_map(|value| line.find(value).map(|index| line[..index].width()))
        })
        .collect::<Vec<_>>();
    assert_eq!(value_columns.len(), 2);
    assert!(!rendered.contains("None"));
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

#[test]
fn model_controls_share_keyboard_and_pointer_actions_without_consuming_search_input() {
    use crate::widgets::list_selection::ListSelection;
    use crate::widgets::list_selection::ListSelectionClick;
    use crate::widgets::list_selection::ListSelectionOutcome;
    use crate::widgets::list_selection::ListSelectionPointerTarget;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    let mut entry = catalog_entry("openai", "gpt-6-astra", "GPT-6 Astra");
    entry.capabilities.fast_mode = ash_protocol::CapabilitySupport::Supported;
    entry.maximum_context_window = Some(1_050_000);
    let catalog = ModelListResult {
        models: vec![entry, catalog_entry("openai", "gpt-4o", "GPT-4o")],
    };
    let mut config = crate::test_support::empty_config_snapshot();
    config.revision = 7;
    let choices = model_choices(&catalog, &config).unwrap();
    let mut picker = ListSelection::new(choices.model, choices.actions);
    let id = crate::widgets::list_selection::ListSelectionItemId::new("openai/gpt-6-astra");
    for (index, control, option) in [
        (0, "fast", super::ModelOption::FastOn),
        (1, "context", super::ModelOption::Context272k),
    ] {
        if index > 0 {
            picker.handle_model_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        }
        let expected = ListSelectionOutcome::Activate(ModelSelectionAction::Configure {
            preference: "openai/gpt-6-astra".into(),
            revision: 7,
            option,
        });
        assert_eq!(
            picker.handle_model_key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE)),
            expected
        );
        assert_eq!(
            picker.handle_model_click(
                &ListSelectionPointerTarget::ItemControl {
                    item: id.clone(),
                    control: control.into()
                },
                ListSelectionClick::Single
            ),
            expected
        );
    }
    assert!(picker.model_key_hints().text().contains("Tab setting"));
    assert!(!picker.model_key_hints().text().contains("f Fast"));
    assert!(!picker.model_key_hints().text().contains("c context"));
    picker.handle_model_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert!(!picker.model_key_hints().text().contains("f Fast"));
    assert!(!picker.model_key_hints().text().contains("c context"));
    assert_eq!(
        picker.handle_model_key(KeyEvent::new(KeyCode::Char('f'), KeyModifiers::NONE)),
        ListSelectionOutcome::Consumed
    );
    picker.handle_model_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));
    for key in ['f', 'c'] {
        picker.handle_model_key(KeyEvent::new(KeyCode::Char(key), KeyModifiers::NONE));
    }
    assert_eq!(picker.state().query(), "fc");
}

#[test]
fn model_controls_use_rendered_columns_for_hit_testing_and_localize_labels() {
    assert_model_controls(100, crate::nls::Language::English);
}

#[test]
fn model_controls_localize_labels_and_pointer_columns_in_chinese() {
    assert_model_controls(100, crate::nls::Language::Chinese);
}

#[test]
fn model_controls_keep_available_settings_visible_on_narrow_terminals() {
    assert_model_controls(40, crate::nls::Language::English);
}

fn assert_model_controls(width: u16, language: crate::nls::Language) {
    use crate::widgets::list_selection::{ListSelectionPointerTarget, pointer_target_at};
    use ratatui::layout::{Position, Rect};
    let mut entry = catalog_entry("openai", "gpt-6-astra", "GPT-6 Astra");
    entry.capabilities.fast_mode = ash_protocol::CapabilitySupport::Supported;
    entry.maximum_context_window = Some(1_050_000);
    let catalog = ModelListResult {
        models: vec![entry, catalog_entry("openai", "gpt-4o", "GPT-4o")],
    };
    let choices = model_choices(&catalog, &crate::test_support::empty_config_snapshot()).unwrap();
    let mut view = ListSelectionState::new(choices.model);
    view.localize(language);
    let mut terminal = Terminal::new(TestBackend::new(width, 9)).unwrap();
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
    let body = Rect::new(0, 0, width, 9);
    let mut hits = Vec::new();
    for y in 0..9 {
        for x in 0..width {
            if let Some(target @ ListSelectionPointerTarget::ItemControl { .. }) =
                pointer_target_at(&view, Rect::default(), body, Position::new(x, y))
            {
                assert_eq!(y, 3, "controls only belong to the supported model row");
                // Wide glyph continuation cells carry no independently rendered style.
                if buffer[(x, y)].symbol() != " " {
                    let focused = matches!(&target, ListSelectionPointerTarget::ItemControl { control, .. } if control == "fast");
                    assert_eq!(
                        buffer[(x, y)]
                            .modifier
                            .contains(ratatui::style::Modifier::UNDERLINED),
                        focused
                    );
                    if focused {
                        assert_eq!(buffer[(x, y)].fg, crate::render::test_context().focus());
                    }
                }
                hits.push(target);
            }
        }
    }
    assert!(hits.iter().any(|target| matches!(target, ListSelectionPointerTarget::ItemControl { control, .. } if control == "fast")));
    assert!(hits.iter().any(|target| matches!(target, ListSelectionPointerTarget::ItemControl { control, .. } if control == "context")));
    assert!(!terminal.backend().to_string().contains('—'));
    assert!(
        (40..width).all(|x| buffer[(x, 3)].symbol() == " "),
        "settings stay next to the model instead of stretching to the edge"
    );
    crate::tui_assert_snapshot!(
        format!("model_controls_{width}_{language:?}"),
        terminal.backend().to_string()
    );
}

#[test]
fn other_provider_controls_follow_capabilities_and_saved_preferences() {
    use crate::widgets::list_selection::ListSelection;
    use crate::widgets::list_selection::ListSelectionClick;
    use crate::widgets::list_selection::ListSelectionItemId;
    use crate::widgets::list_selection::ListSelectionOutcome;
    use crate::widgets::list_selection::ListSelectionPointerTarget;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    let rows = [
        (
            "anthropic",
            "claude-opus-5-5",
            "Claude Opus 5.5",
            true,
            Some(1_000_000),
        ),
        (
            "google",
            "gemini-3.8-flash",
            "Gemini 3.8 Flash",
            true,
            Some(1_048_576),
        ),
        ("xai", "grok-4.7", "Grok 4.7", true, Some(500_000)),
        (
            "minimax",
            "MiniMax-M2.7",
            "MiniMax M2.7",
            true,
            Some(204_800),
        ),
        (
            "qwen",
            "qwen3.8-max",
            "Qwen 3.8 Max",
            false,
            Some(1_000_000),
        ),
        ("kimi", "kimi-k3", "Kimi K3", false, Some(1_000_000)),
        (
            "deepseek",
            "deepseek-v4-pro",
            "DeepSeek V4 Pro",
            false,
            Some(1_000_000),
        ),
        (
            "mimo",
            "mimo-v2.6-pro",
            "MiMo V2.6 Pro",
            false,
            Some(1_000_000),
        ),
        ("glm", "glm-5.3", "GLM-5.3", false, Some(1_000_000)),
    ];
    let catalog = ModelListResult {
        models: rows
            .iter()
            .map(|(provider, model, name, fast, window)| {
                let mut entry = catalog_entry(provider, model, name);
                if *fast {
                    entry.capabilities.fast_mode = ash_protocol::CapabilitySupport::Supported;
                }
                entry.maximum_context_window = *window;
                entry
            })
            .collect(),
    };
    let mut config = crate::test_support::empty_config_snapshot();
    config.revision = 9;
    let mut google = provider_config("google");
    google.fast_models.push("gemini-3.8-flash".into());
    config.providers.insert("google".into(), google);
    let mut qwen = provider_config("qwen");
    qwen.model_context.insert(
        "qwen3.8-max".into(),
        ash_app_server_protocol::protocol::config::ModelContextConfigDto {
            context_window: 272_000,
            auto_compact_token_limit: None,
        },
    );
    config.providers.insert("qwen".into(), qwen);
    for (provider, model, _, fast, window) in rows {
        let preference = format!("{provider}/{model}");
        let choices = model_choices(&catalog, &config).unwrap();
        let mut picker = ListSelection::new(choices.model, choices.actions);
        assert!(
            picker
                .state_mut()
                .focus_item(&ListSelectionItemId::new(&preference))
        );
        let mut visited = false;
        for (control, option) in [
            (
                "fast",
                fast.then_some(if provider == "google" {
                    super::ModelOption::FastOff
                } else {
                    super::ModelOption::FastOn
                }),
            ),
            (
                "context",
                window.filter(|maximum| *maximum >= 1_000_000).map(|_| {
                    if provider == "qwen" {
                        super::ModelOption::Context1m
                    } else {
                        super::ModelOption::Context272k
                    }
                }),
            ),
        ] {
            if let Some(option) = option {
                if visited {
                    picker.handle_model_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
                }
                visited = true;
                let expected = ListSelectionOutcome::Activate(ModelSelectionAction::Configure {
                    preference: preference.clone(),
                    revision: 9,
                    option,
                });
                assert_eq!(
                    picker.handle_model_key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE)),
                    expected
                );
                assert_eq!(
                    picker.handle_model_click(
                        &ListSelectionPointerTarget::ItemControl {
                            item: ListSelectionItemId::new(&preference),
                            control: control.into(),
                        },
                        ListSelectionClick::Single
                    ),
                    expected
                );
            }
        }
    }
    let choices = model_choices(&catalog, &config).unwrap();
    let mut view = ListSelectionState::new(choices.model);
    view.localize(crate::nls::Language::Chinese);
    let mut terminal = Terminal::new(TestBackend::new(100, 15)).unwrap();
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
    crate::tui_assert_snapshot!(
        "other_provider_model_controls_chinese",
        terminal.backend().to_string()
    );
}

#[test]
fn model_tab_cycles_only_editable_settings_resets_on_movement_and_removes_none() {
    use crate::widgets::list_selection::ListSelection;
    use crate::widgets::list_selection::ListSelectionItemFocus;
    use crate::widgets::list_selection::ListSelectionItemId;
    use crate::widgets::list_selection::ListSelectionOutcome;
    use ash_protocol::ReasoningEffort;
    use crossterm::event::KeyCode;
    use crossterm::event::KeyEvent;
    use crossterm::event::KeyModifiers;
    let mut models = Vec::new();
    for bits in (0..8).rev() {
        let mut entry = catalog_entry("openai", &format!("model-{bits}"), &format!("Model {bits}"));
        entry.supported_reasoning_efforts = if bits & 1 != 0 {
            vec![
                ReasoningEffort::None,
                ReasoningEffort::Low,
                ReasoningEffort::High,
            ]
        } else {
            vec![ReasoningEffort::None]
        };
        entry.model_reasoning_effort = Some(ReasoningEffort::None);
        if bits & 2 != 0 {
            entry.capabilities.fast_mode = ash_protocol::CapabilitySupport::Supported;
        }
        if bits & 4 != 0 {
            entry.maximum_context_window = Some(1_000_000);
        }
        models.push(entry);
    }
    let catalog = ModelListResult { models };
    let mut config = crate::test_support::empty_config_snapshot();
    config.model = Some(ModelRefDto {
        provider: "openai".into(),
        model: "model-7".into(),
    });
    config.model_reasoning_effort = Some(ReasoningEffort::None);
    let choices = model_choices(&catalog, &config).unwrap();
    let mut picker = ListSelection::new(choices.model, choices.actions);
    for bits in (0..8).rev() {
        let id = ListSelectionItemId::new(format!("openai/model-{bits}"));
        assert_eq!(picker.state().selected_item().unwrap().id(), Some(&id));
        let mut order = Vec::new();
        if bits & 1 != 0 {
            order.push(ListSelectionItemFocus::Segmented);
        }
        if bits & 2 != 0 {
            order.push(ListSelectionItemFocus::Control("fast".into()));
        }
        if bits & 4 != 0 {
            order.push(ListSelectionItemFocus::Control("context".into()));
        }
        assert_eq!(
            picker.state().focused_item_setting(),
            order.first().cloned()
        );
        let ModelSelectionAction::Select {
            supported_efforts,
            default_effort,
            ..
        } = picker.action(&id).unwrap()
        else {
            panic!()
        };
        assert!(!supported_efforts.contains(&ReasoningEffort::None));
        assert_eq!(
            *default_effort,
            (bits & 1 != 0).then_some(ReasoningEffort::Low)
        );
        for index in 1..=order.len().max(1) {
            assert_eq!(
                picker.handle_model_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)),
                ListSelectionOutcome::Consumed
            );
            assert_eq!(picker.state().selected_item().unwrap().id(), Some(&id));
            assert_eq!(
                picker.state().focused_item_setting(),
                if order.is_empty() {
                    None
                } else {
                    Some(order[index % order.len()].clone())
                }
            );
        }
        for index in 1..=order.len().max(1) {
            picker.handle_model_key(KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT));
            assert_eq!(
                picker.state().focused_item_setting(),
                if order.is_empty() {
                    None
                } else {
                    Some(order[(order.len() - index % order.len()) % order.len()].clone())
                }
            );
        }
        if bits & 1 != 0 {
            for key in [KeyCode::Right, KeyCode::Right, KeyCode::Left] {
                assert_eq!(
                    picker.handle_model_key(KeyEvent::new(key, KeyModifiers::NONE)),
                    ListSelectionOutcome::Consumed
                );
                assert!(matches!(
                    picker.action(&id),
                    Some(ModelSelectionAction::Select {
                        effort: Some(ReasoningEffort::Low | ReasoningEffort::High),
                        ..
                    })
                ));
            }
        }
        // Move away from the initial field before selecting the next model.
        picker.handle_model_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        if bits > 0 {
            picker.handle_model_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        }
    }
    assert!(!picker.model_key_hints().text().contains("Tab"));
    for key in ['f', 'c'] {
        assert_eq!(
            picker.handle_model_key(KeyEvent::new(KeyCode::Char(key), KeyModifiers::NONE)),
            ListSelectionOutcome::Consumed
        );
    }
    // Up resets the destination row too; the context-only row starts directly at context.
    picker.handle_model_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    assert_eq!(
        picker.state().focused_item_setting(),
        Some(ListSelectionItemFocus::Segmented)
    );
    picker
        .state_mut()
        .focus_item(&ListSelectionItemId::new("openai/model-4"));
    assert_eq!(
        picker.state().focused_item_setting(),
        Some(ListSelectionItemFocus::Control("context".into()))
    );
}

#[test]
fn model_settings_refresh_keeps_field_focus_and_unconfirmed_effort() {
    use crate::widgets::list_selection::ListSelection;
    use crate::widgets::list_selection::ListSelectionItemFocus;
    use crate::widgets::list_selection::ListSelectionItemId;
    use crate::widgets::list_selection::ListSelectionOutcome;
    use ash_protocol::ReasoningEffort;
    use crossterm::event::KeyCode;
    use crossterm::event::KeyEvent;
    use crossterm::event::KeyModifiers;
    let mut entry = catalog_entry("openai", "gpt-6-astra", "GPT-6 Astra");
    entry.supported_reasoning_efforts = vec![ReasoningEffort::Low, ReasoningEffort::High];
    entry.capabilities.fast_mode = ash_protocol::CapabilitySupport::Supported;
    entry.maximum_context_window = Some(1_050_000);
    let mut catalog = ModelListResult {
        models: vec![entry],
    };
    let mut config = crate::test_support::empty_config_snapshot();
    config.revision = 7;
    let choices = model_choices(&catalog, &config).unwrap();
    let mut picker = ListSelection::new(choices.model, choices.actions);
    picker.handle_model_key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE));
    picker.handle_model_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    let id = ListSelectionItemId::new("openai/gpt-6-astra");
    let mut provider = provider_config("openai");
    provider.fast_models.push("gpt-6-astra".into());
    config.providers.insert("openai".into(), provider);
    config.revision = 8;
    picker.replace_model_choices(model_choices(&catalog, &config).unwrap());
    assert_eq!(
        picker.state().focused_item_setting(),
        Some(ListSelectionItemFocus::Control("fast".into()))
    );
    assert!(matches!(
        picker.action(&id),
        Some(ModelSelectionAction::Select {
            effort: Some(ReasoningEffort::High),
            ..
        })
    ));
    assert_eq!(
        picker.handle_model_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE)),
        ListSelectionOutcome::Activate(ModelSelectionAction::Configure {
            preference: "openai/gpt-6-astra".into(),
            revision: 8,
            option: super::ModelOption::FastOff
        })
    );
    catalog.models[0].capabilities.fast_mode = ash_protocol::CapabilitySupport::Unsupported;
    picker.replace_model_choices(model_choices(&catalog, &config).unwrap());
    assert_eq!(
        picker.state().focused_item_setting(),
        Some(ListSelectionItemFocus::Segmented)
    );
}

#[test]
fn model_tab_focus_is_visible_for_each_setting_in_chinese_and_on_narrow_terminals() {
    use crate::widgets::list_selection::ListSelection;
    use crate::widgets::list_selection::ListSelectionPointerTarget;
    use crate::widgets::list_selection::pointer_target_at;
    use ash_protocol::ReasoningEffort;
    use crossterm::event::KeyCode;
    use crossterm::event::KeyEvent;
    use crossterm::event::KeyModifiers;
    use ratatui::layout::Position;
    use ratatui::layout::Rect;
    use ratatui::style::Modifier;
    let mut entry = catalog_entry("openai", "gpt-6-astra", "GPT-6 Astra");
    entry.supported_reasoning_efforts = vec![
        ReasoningEffort::Low,
        ReasoningEffort::Medium,
        ReasoningEffort::High,
    ];
    entry.model_reasoning_effort = Some(ReasoningEffort::Medium);
    entry.capabilities.fast_mode = ash_protocol::CapabilitySupport::Supported;
    entry.maximum_context_window = Some(1_050_000);
    let catalog = ModelListResult {
        models: vec![entry],
    };
    let mut frames = Vec::new();
    for width in [80, 40] {
        let choices =
            model_choices(&catalog, &crate::test_support::empty_config_snapshot()).unwrap();
        let mut picker = ListSelection::new(choices.model, choices.actions);
        picker.state_mut().localize(crate::nls::Language::Chinese);
        for setting in ["effort", "fast", "context"] {
            let mut terminal = Terminal::new(TestBackend::new(width, 7)).unwrap();
            terminal
                .draw(|frame| {
                    draw_body_with_pointer(
                        frame,
                        frame.area(),
                        picker.state(),
                        None,
                        None,
                        crate::render::test_context(),
                    )
                })
                .unwrap();
            let output = terminal.backend().to_string();
            assert_eq!(output.contains('←'), setting == "effort");
            assert_eq!(output.contains('→'), setting == "effort");
            let buffer = terminal.backend().buffer();
            let body = Rect::new(0, 0, width, 7);
            let mut focused_hits = 0;
            for x in 0..width {
                if let Some(ListSelectionPointerTarget::ItemControl { control, .. }) =
                    pointer_target_at(picker.state(), Rect::default(), body, Position::new(x, 3))
                {
                    if buffer[(x, 3)].symbol() != " " {
                        assert_eq!(
                            buffer[(x, 3)].modifier.contains(Modifier::UNDERLINED),
                            control == setting
                        );
                        if control == setting {
                            focused_hits += 1;
                        }
                    }
                }
            }
            assert_eq!(focused_hits > 0, setting != "effort");
            assert_eq!(buffer[(0, 3)].symbol(), ">");
            frames.push(format!("{width} columns · {setting}\n{output}"));
            picker.handle_model_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        }
    }
    crate::tui_assert_snapshot!("model_tab_focus_chinese", frames.join("\n"));
}
