use super::advisor_choices;
use super::config_choices;
use super::provider_api_key_prompt;
use crate::config::ConfigSelectionAction;
use crate::config::TerminalSettings;
use crate::nls::Language;
use crate::status::StatusLineSettings;
use crate::test_support::empty_config_snapshot;
use crate::thread::composer::ChatInputMode;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionState;
use crate::widgets::text_prompt::TextPrompt;
use crate::widgets::text_prompt::TextPromptOutcome;
use ash_app_server_protocol::protocol::provider::{
    ProviderApiKeyPolicyDto, ProviderCatalogEntryDto, ProviderListResult,
};
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;

fn providers() -> ProviderListResult {
    ProviderListResult {
        providers: vec![
            ProviderCatalogEntryDto {
                provider: "openai".into(),
                display_name: "OpenAI".into(),
                api_key_policy: ProviderApiKeyPolicyDto::Required,
                api_key_configured: false,
            },
            ProviderCatalogEntryDto {
                provider: "ollama".into(),
                display_name: "Ollama".into(),
                api_key_policy: ProviderApiKeyPolicyDto::Unsupported,
                api_key_configured: false,
            },
        ],
    }
}

#[test]
fn provider_rows_use_distinct_subscription_and_api_names() {
    let mut catalog = providers();
    catalog.providers.push(ProviderCatalogEntryDto {
        provider: "kimi".into(),
        display_name: "Kimi".into(),
        api_key_policy: ProviderApiKeyPolicyDto::Required,
        api_key_configured: false,
    });
    catalog.providers.push(ProviderCatalogEntryDto {
        provider: "zai".into(),
        display_name: "zAI".into(),
        api_key_policy: ProviderApiKeyPolicyDto::Required,
        api_key_configured: false,
    });
    catalog.providers.push(ProviderCatalogEntryDto {
        provider: "xai".into(),
        display_name: "xAI".into(),
        api_key_policy: ProviderApiKeyPolicyDto::Required,
        api_key_configured: false,
    });
    catalog.providers.push(ProviderCatalogEntryDto {
        provider: "google".into(),
        display_name: "Google".into(),
        api_key_policy: ProviderApiKeyPolicyDto::Required,
        api_key_configured: false,
    });
    let choices = config_choices(
        &empty_config_snapshot(),
        &catalog,
        TerminalSettings::default(),
        StatusLineSettings::default(),
    );
    let mut state = ListSelectionState::new(choices.model);
    state.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    let labels = state
        .visible_items()
        .iter()
        .map(|item| item.label())
        .collect::<Vec<_>>();
    assert_eq!(
        labels,
        vec![
            "Subscriptions",
            "ChatGPT",
            "Kimi",
            "BigModel",
            "Super Grok",
            "API",
            "OpenAI",
            "Ollama",
            "Kimi",
            "zAI",
            "xAI",
            "Google",
            "New custom provider",
        ]
    );
    let actions = &choices.actions;
    for (label, row_id) in [
        ("Kimi", "kimi-subscription"),
        ("BigModel", "zai-subscription"),
        ("Super Grok", "xai-subscription"),
    ] {
        let id = state
            .visible_items()
            .iter()
            .find(|item| {
                item.label() == label && item.id() == Some(&ListSelectionItemId::new(row_id))
            })
            .and_then(|item| item.id())
            .unwrap_or_else(|| panic!("{label} row must open its subscription panel"));
        assert!(matches!(
            actions.get(&id),
            Some(ConfigSelectionAction::OpenSubscription(_))
        ));
    }
}

#[test]
fn down_from_provider_tab_advances_from_the_highlighted_kimi_row() {
    let catalog = ProviderListResult {
        providers: vec![
            ProviderCatalogEntryDto {
                provider: "kimi".into(),
                display_name: "Kimi".into(),
                api_key_policy: ProviderApiKeyPolicyDto::Required,
                api_key_configured: false,
            },
            ProviderCatalogEntryDto {
                provider: "openai".into(),
                display_name: "OpenAI".into(),
                api_key_policy: ProviderApiKeyPolicyDto::Required,
                api_key_configured: false,
            },
        ],
    };
    let mut editor = super::ConfigEditor::new(config_choices(
        &empty_config_snapshot(),
        &catalog,
        TerminalSettings::default(),
        StatusLineSettings::default(),
    ));

    editor.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    let selection = editor.selection().unwrap();
    assert!(selection.items_focused());
    assert_eq!(selection.selected_item().unwrap().label(), "Kimi");

    editor.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    let selection = editor.selection().unwrap();
    assert!(selection.items_focused());
    assert_eq!(selection.selected_item().unwrap().label(), "ChatGPT");
    assert!(!selection.search().unwrap().input_active());
}

#[test]
fn advisor_choices_are_localized_and_config_owned() {
    let choices = advisor_choices(
        &empty_config_snapshot(),
        &ash_app_server_protocol::protocol::model::ModelListResult { models: vec![] },
        Language::Chinese,
    );
    let state = ListSelectionState::new(choices.settings.model);
    assert_eq!(state.title(), "顾问");
    assert_eq!(state.visible_items()[0].label(), "启用顾问");
    assert_eq!(state.visible_items()[1].label(), "顾问模型");
    assert!(
        choices
            .settings
            .actions
            .values()
            .any(|action| action == &ConfigSelectionAction::OpenAdvisorModel)
    );
    let picker = ListSelectionState::new(choices.models.model);
    assert_eq!(picker.title(), "顾问模型");
    assert!(picker.visible_items().is_empty());
    assert!(choices.models.actions.is_empty());
}

#[test]
fn advisor_entry_belongs_to_general_not_providers() {
    let choices = config_choices(
        &empty_config_snapshot(),
        &providers(),
        TerminalSettings::default(),
        StatusLineSettings::default(),
    );
    let mut state = ListSelectionState::new(choices.model);
    assert_eq!(state.active_tab().label(), "General");
    assert!(
        state
            .visible_items()
            .iter()
            .any(|item| item.label() == "Advisor")
    );

    state.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    assert_eq!(state.active_tab().label(), "Providers");
    assert!(
        state
            .visible_items()
            .iter()
            .all(|item| item.label() != "Advisor")
    );
}

#[test]
fn configured_advisor_model_is_selected_when_opening_config() {
    use ash_app_server_protocol::protocol::model::{ModelCatalogEntry, ModelListResult};
    use ash_protocol::{
        AdvisorConfig, ModelAccess, ModelCapabilities, ModelId, ModelOutputTransport, ModelRef,
        ProviderId,
    };

    let model = ModelRef::new(
        ProviderId::new("openai").unwrap(),
        ModelId::new("gpt-ash").unwrap(),
    );
    let mut config = empty_config_snapshot();
    config.advisor = Some(AdvisorConfig::new(model.clone()));
    let mut catalog = ModelListResult {
        models: vec![ModelCatalogEntry {
            model,
            display_name: "GPT Ash".into(),
            access: ModelAccess::Unknown,
            output_transport: ModelOutputTransport::Unary,
            context_window: None,
            auto_compact_token_limit: None,
            available_context_window: None,
            capabilities: ModelCapabilities::UNKNOWN,
            supported_reasoning_efforts: Vec::new(),
            model_reasoning_effort: None,
            default_personality: None,
        }],
    };
    let unavailable = advisor_choices(&empty_config_snapshot(), &catalog, Language::English);
    assert_eq!(
        ListSelectionState::new(unavailable.models.model)
            .visible_items()
            .len(),
        0
    );
    config.providers.insert(
        "openai".into(),
        ash_app_server_protocol::protocol::config::ProviderConfigDto {
            provider: "openai".into(),
            custom: None,
            base_url: None,
            max_output_tokens: None,
            model_context: Default::default(),
        },
    );
    let choices = advisor_choices(&config, &catalog, Language::English);
    let state = ListSelectionState::new(choices.models.model);
    assert_eq!(state.selected_item().unwrap().label(), "GPT Ash");
    assert_eq!(state.title(), "Advisor model");
    assert!(
        choices
            .models
            .actions
            .values()
            .any(|action| action == &ConfigSelectionAction::SetAdvisor(config.advisor.clone()))
    );
    assert!(choices.settings.actions.values().any(|action| action
        == &ConfigSelectionAction::SetAdvisor(Some(AdvisorConfig {
            enabled: false,
            ..config.advisor.clone().unwrap()
        }))));
    let mut disabled = config.advisor.clone().unwrap();
    disabled.enabled = false;
    disabled.max_calls = 5;
    config.advisor = Some(disabled.clone());
    let other_model = ModelRef::new(
        ProviderId::new("openai").unwrap(),
        ModelId::new("gpt-ash-review").unwrap(),
    );
    let mut other_entry = catalog.models[0].clone();
    other_entry.model = other_model.clone();
    other_entry.display_name = "GPT Ash Review".into();
    catalog.models.push(other_entry);
    let choices = advisor_choices(&config, &catalog, Language::English);
    let state = ListSelectionState::new(choices.models.model);
    assert_eq!(state.selected_item().unwrap().label(), "GPT Ash");
    assert!(choices.settings.actions.values().any(|action| action
        == &ConfigSelectionAction::SetAdvisor(Some(AdvisorConfig {
            enabled: true,
            ..disabled.clone()
        }))));
    assert!(
        choices
            .models
            .actions
            .values()
            .any(|action| action == &ConfigSelectionAction::SetAdvisor(None))
    );
    assert!(choices.models.actions.values().any(|action| matches!(
        action,
        ConfigSelectionAction::SetAdvisor(Some(advisor))
            if advisor.model == other_model && !advisor.enabled && advisor.max_calls == 3
    )));
    let mut unselected = config;
    unselected.advisor = None;
    let choices = advisor_choices(&unselected, &catalog, Language::English);
    assert!(choices.models.actions.values().any(|action| matches!(
        action,
        ConfigSelectionAction::SetAdvisor(Some(advisor)) if !advisor.enabled
    )));
}

#[test]
fn advisor_switch_refreshes_in_place_and_keeps_the_model() {
    use ash_protocol::{AdvisorConfig, ModelId, ModelRef, ProviderId};

    let mut config = empty_config_snapshot();
    let model = ModelRef::new(
        ProviderId::new("openai").unwrap(),
        ModelId::new("gpt-ash").unwrap(),
    );
    let mut advisor = AdvisorConfig::new(model);
    advisor.enabled = false;
    config.advisor = Some(advisor.clone());
    let catalog = ash_app_server_protocol::protocol::model::ModelListResult { models: vec![] };
    let mut editor = super::ConfigEditor::new(config_choices(
        &config,
        &providers(),
        TerminalSettings::default(),
        StatusLineSettings::default(),
    ));
    editor.open_advisor(advisor_choices(&config, &catalog, Language::English));
    assert!(matches!(
        editor.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        super::ConfigEditorOutcome::Action(ConfigSelectionAction::SetAdvisor(Some(next)))
            if next.enabled && next.model == advisor.model
    ));

    config.advisor.as_mut().unwrap().enabled = true;
    editor.update_advisor(advisor_choices(&config, &catalog, Language::English));
    let state = editor.selection().unwrap();
    assert_eq!(state.title(), "Advisor");
    assert!(
        state.visible_items()[0]
            .description()
            .unwrap()
            .contains("On")
    );
    assert!(
        state.visible_items()[1]
            .description()
            .unwrap()
            .contains("openai/gpt-ash")
    );
}

#[test]
fn screen_mode_can_be_changed_with_activation() {
    for mode in [
        crate::terminal::ScreenMode::Fullscreen,
        crate::terminal::ScreenMode::Inline,
    ] {
        for code in [KeyCode::Enter, KeyCode::Char(' ')] {
            let mut terminal = TerminalSettings::default();
            terminal.set_screen_mode(mode);
            let mut editor = super::ConfigEditor::new(config_choices(
                &empty_config_snapshot(),
                &providers(),
                terminal,
                StatusLineSettings::default(),
            ));
            for _ in 0..7 {
                editor.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
            }
            assert!(
                matches!(editor.handle_key(KeyEvent::new(code, KeyModifiers::NONE)),
                super::ConfigEditorOutcome::Action(ConfigSelectionAction::SetTerminalSettings(edit))
                if edit.terminal.screen_mode() == mode.next())
            );
        }
    }
}

#[test]
fn config_editor_organizes_the_snapshot_into_searchable_tabs() {
    let mut config = empty_config_snapshot();
    config.revision = 4;
    config.generation = 5;
    let providers = providers();
    let view = config_choices(
        &config,
        &providers,
        TerminalSettings::default(),
        StatusLineSettings::default(),
    );
    assert_eq!(
        view.model.key_hints().text(),
        "Enter/Space change · ←/→ details · Tab tabs · / search · Esc close"
    );
    let mut state = ListSelectionState::new(view.model);

    assert_eq!(state.title(), "Config");
    assert!(state.search().is_some());
    assert_eq!(
        state
            .tabs()
            .iter()
            .map(|tab| tab.label())
            .collect::<Vec<_>>(),
        vec!["General", "Providers", "Issues"]
    );
    assert!(state.visible_items().iter().all(|item| !matches!(
        item.label(),
        "Revision" | "Generation" | "Model" | "Approval review model" | "Providers"
    )));
    assert!(
        state
            .visible_items()
            .iter()
            .all(|item| item.label() != "Language servers")
    );
    assert!(
        !state
            .visible_items()
            .iter()
            .any(|item| matches!(item.label(), "Enhanced TUI" | "Copy on select"))
    );
    let vim_mode = &state.visible_items()[0];
    assert_eq!(vim_mode.label(), "Vim mode");
    assert_eq!(
        vim_mode.description(),
        Some("Use Vim editing in ChatInput off")
    );
    assert!(matches!(
        view.actions.get(vim_mode.id().unwrap()).unwrap(),
        ConfigSelectionAction::SetVimMode(edit)
            if edit.terminal.input_mode() == ChatInputMode::Vim
    ));
    let memory_diagnostics = &state.visible_items()[1];
    assert_eq!(memory_diagnostics.label(), "Memory diagnostics");
    assert_eq!(
        memory_diagnostics.description(),
        Some("Continuously collect bounded memory evidence off")
    );
    assert!(matches!(
        view.actions
            .get(memory_diagnostics.id().unwrap())
            .unwrap(),
        ConfigSelectionAction::SetTerminalSettings(edit)
            if edit.terminal.memory_diagnostics()
    ));
    let auto_update = &state.visible_items()[2];
    assert_eq!(auto_update.label(), "Automatic updates");
    assert_eq!(
        auto_update.description(),
        Some("Choose release cadence Latest")
    );
    assert!(matches!(
        view.actions.get(auto_update.id().unwrap()).unwrap(),
        ConfigSelectionAction::SetUpdatePolicy(edit)
            if edit.terminal.auto_update() == crate::UpdatePolicy::Latest
    ));
    let git_changes = &state.visible_items()[3];
    assert_eq!(git_changes.label(), "Show Git changes as diff");
    assert_eq!(
        git_changes.description(),
        Some("Show added and deleted lines instead of changed files off")
    );
    assert!(matches!(
        view.actions.get(git_changes.id().unwrap()).unwrap(),
        ConfigSelectionAction::SetShowGitChangesAsDiff(edit)
            if edit.status_line.show_git_changes_as_diff()
    ));
    let language = &state.visible_items()[4];
    assert_eq!(language.label(), "Language");
    assert_eq!(
        language.description(),
        Some("Change the interface language English")
    );
    assert!(matches!(
        view.actions.get(language.id().unwrap()).unwrap(),
        ConfigSelectionAction::SetLanguage(edit)
            if edit.terminal.language() == Language::English
    ));
    let key_hint_style = &state.visible_items()[6];
    assert_eq!(key_hint_style.label(), "Key hint style");
    assert_eq!(
        key_hint_style.description(),
        Some("Emphasize keys over their descriptions Contrast")
    );
    assert!(matches!(
        view.actions.get(key_hint_style.id().unwrap()).unwrap(),
        ConfigSelectionAction::SetTerminalSettings(edit)
            if edit.terminal.key_hint_style() == crate::config::KeyHintStyle::Muted
    ));

    state.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    state.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    let _ = state.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    assert_eq!(state.visible_items().len(), 6);
    assert_eq!(state.visible_items()[0].label(), "Subscriptions");
    assert_eq!(state.visible_items()[1].label(), "ChatGPT");
    assert_eq!(state.visible_items()[2].label(), "API");
    assert_eq!(state.visible_items()[3].label(), "OpenAI");
    assert_eq!(state.visible_items()[4].label(), "Ollama");
    assert_eq!(state.visible_items()[5].label(), "New custom provider");
    assert_eq!(state.selected_item().unwrap().label(), "ChatGPT");
    assert!(
        state
            .visible_items()
            .iter()
            .all(|item| item.description().is_none())
    );
    assert!(matches!(
        view.actions
            .get(state.visible_items()[3].id().unwrap())
            .unwrap(),
        ConfigSelectionAction::OpenProviderApiKey { .. }
    ));
    assert!(state.visible_items()[4].id().is_none());
}

#[test]
fn provider_sections_keep_subscription_navigation_and_search_actionable() {
    let mut catalog = providers();
    catalog.providers.push(ProviderCatalogEntryDto {
        provider: "xai".into(),
        display_name: "xAI".into(),
        api_key_policy: ProviderApiKeyPolicyDto::Unsupported,
        api_key_configured: false,
    });
    let choices = config_choices(
        &empty_config_snapshot(),
        &catalog,
        TerminalSettings::default(),
        StatusLineSettings::default(),
    );
    let mut state = ListSelectionState::new(choices.model);
    state.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    let labels = state
        .visible_items()
        .iter()
        .map(|item| item.label())
        .collect::<Vec<_>>();
    assert!(labels.contains(&"Super Grok"));
    assert!(!labels.contains(&"xAI"));
    let xai_id = state
        .visible_items()
        .iter()
        .find(|item| item.label() == "Super Grok")
        .unwrap()
        .id()
        .unwrap()
        .clone();
    assert!(state.focus_item(&xai_id));
    assert!(matches!(
        choices
            .actions
            .get(state.selected_item().unwrap().id().unwrap()),
        Some(ConfigSelectionAction::OpenSubscription(
            super::super::SubscriptionProvider::Xai
        ))
    ));

    state.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));
    state.handle_paste("OpenAI".into());
    assert_eq!(state.visible_items().len(), 1);
    assert_eq!(state.visible_items()[0].label(), "OpenAI");
}

#[test]
fn provider_sections_open_connection_from_the_same_list() {
    let catalog = providers();
    let choices = || {
        config_choices(
            &empty_config_snapshot(),
            &catalog,
            TerminalSettings::default(),
            StatusLineSettings::default(),
        )
    };
    let mut subscription = super::ConfigEditor::new(choices());
    subscription.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    assert!(matches!(
        subscription.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        super::ConfigEditorOutcome::Action(ConfigSelectionAction::OpenSubscription(
            super::super::SubscriptionProvider::ChatGpt
        ))
    ));

    let mut api = super::ConfigEditor::new(choices());
    for code in [KeyCode::Tab, KeyCode::Down] {
        api.handle_key(KeyEvent::new(code, KeyModifiers::NONE));
    }
    assert_eq!(
        api.selection().unwrap().selected_item().unwrap().label(),
        "OpenAI"
    );
    assert!(matches!(
        api.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        super::ConfigEditorOutcome::Consumed
    ));
    assert!(matches!(api.page(), super::ConfigEditorPage::Prompt(_)));
}

#[test]
fn git_autofetch_settings_change_the_shared_config_snapshot() {
    let choices = || {
        config_choices(
            &empty_config_snapshot(),
            &providers(),
            TerminalSettings::default(),
            StatusLineSettings::default(),
        )
    };
    let mut mode = super::ConfigEditor::new(choices());
    for _ in 0..9 {
        mode.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    }
    assert!(matches!(
        mode.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        super::ConfigEditorOutcome::Action(ConfigSelectionAction::SetGitMode(edit))
            if edit.server_config.git.autofetch
                == ash_app_server_protocol::protocol::config::GitAutoFetchModeDto::Default
    ));

    let mut period = super::ConfigEditor::new(choices());
    for _ in 0..10 {
        period.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    }
    assert!(matches!(
        period.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        super::ConfigEditorOutcome::Action(ConfigSelectionAction::SetGitPeriod(edit))
            if edit.server_config.git.autofetch_period == 300
    ));
}

#[test]
fn issue_settings_only_control_browser_refresh() {
    let spec = config_choices(
        &empty_config_snapshot(),
        &providers(),
        TerminalSettings::default(),
        StatusLineSettings::default(),
    );
    for id in [
        "issue-workflow",
        "issue-merge-recommendations",
        "issue-analysis-model",
    ] {
        assert!(!spec.actions.contains_key(
            &crate::widgets::list_selection::ListSelectionItemId::new(id)
        ));
    }
    assert!(matches!(
        spec.actions
            .get(&crate::widgets::list_selection::ListSelectionItemId::new(
                "issue-refresh"
            )),
        Some(ConfigSelectionAction::AdjustIssueRefresh(_))
    ));
}

#[test]
fn language_setting_cycles_with_activation_and_directional_keys() {
    let choices = || {
        config_choices(
            &empty_config_snapshot(),
            &providers(),
            TerminalSettings::default(),
            StatusLineSettings::default(),
        )
    };
    let mut editor = super::ConfigEditor::new(choices());
    for _ in 0..4 {
        editor.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    }

    assert!(matches!(
        editor.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        super::ConfigEditorOutcome::Action(ConfigSelectionAction::SetLanguage(edit))
            if edit.terminal.language() == Language::Japanese
    ));

    let mut editor = super::ConfigEditor::new(choices());
    for _ in 0..4 {
        editor.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    }
    assert!(matches!(
        editor.handle_key(KeyEvent::new(KeyCode::Char(' '), KeyModifiers::NONE)),
        super::ConfigEditorOutcome::Action(ConfigSelectionAction::SetLanguage(edit))
            if edit.terminal.language() == Language::Japanese
    ));

    let mut editor = super::ConfigEditor::new(choices());
    for _ in 0..4 {
        editor.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    }
    assert!(matches!(
        editor.handle_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE)),
        super::ConfigEditorOutcome::Consumed
    ));
}

#[test]
fn config_root_uses_the_selected_language_through_nls() {
    let mut terminal = TerminalSettings::default();
    terminal.set_language(Language::Chinese);
    let view = config_choices(
        &empty_config_snapshot(),
        &providers(),
        terminal,
        StatusLineSettings::default(),
    );
    let state = ListSelectionState::new(view.model);

    assert_eq!(state.title(), "配置");
    assert_eq!(
        state
            .tabs()
            .iter()
            .map(|tab| tab.label())
            .collect::<Vec<_>>(),
        vec!["通用", "提供商", "议题"]
    );
    assert_eq!(state.visible_items()[0].label(), "Vim 模式");
    assert_eq!(state.visible_items()[7].label(), "屏幕模式");
    assert_eq!(state.visible_items()[1].label(), "内存诊断");
    assert_eq!(state.visible_items()[2].label(), "自动更新");
    assert_eq!(
        state.visible_items()[2].description(),
        Some("选择版本更新节奏 最新")
    );
    assert_eq!(state.visible_items()[4].label(), "语言");
    assert_eq!(
        state.visible_items()[4].description(),
        Some("切换界面语言 中文")
    );
    assert_eq!(state.visible_items()[6].label(), "按键提示风格");
    assert_eq!(state.visible_items()[11].label(), "Git 分支标识");
}

#[test]
fn key_hint_style_cycles_with_activation() {
    use crate::widgets::list_selection::ListSelectionItemId;
    for (key, expected) in [
        (KeyCode::Enter, crate::config::KeyHintStyle::Muted),
        (KeyCode::Char(' '), crate::config::KeyHintStyle::Muted),
    ] {
        let mut editor = super::ConfigEditor::new(config_choices(
            &empty_config_snapshot(),
            &providers(),
            TerminalSettings::default(),
            StatusLineSettings::default(),
        ));
        assert!(
            editor
                .selection
                .state_mut()
                .focus_item(&ListSelectionItemId::new("key-hint-style"))
        );
        assert!(matches!(
            editor.handle_key(KeyEvent::new(key, KeyModifiers::NONE)),
            super::ConfigEditorOutcome::Action(ConfigSelectionAction::SetTerminalSettings(edit))
                if edit.terminal.key_hint_style() == expected
        ));
    }
}

#[test]
fn glyph_set_cycles_with_activation() {
    use crate::widgets::list_selection::ListSelectionItemId;
    for (current, expected) in [
        (
            crate::config::GlyphSet::Powerline,
            crate::config::GlyphSet::Plain,
        ),
        (
            crate::config::GlyphSet::Plain,
            crate::config::GlyphSet::Powerline,
        ),
    ] {
        let mut terminal = TerminalSettings::default();
        terminal.set_glyph_set(current);
        for key in [KeyCode::Enter, KeyCode::Char(' ')] {
            let mut editor = super::ConfigEditor::new(config_choices(
                &empty_config_snapshot(),
                &providers(),
                terminal,
                StatusLineSettings::default(),
            ));
            assert!(
                editor
                    .selection
                    .state_mut()
                    .focus_item(&ListSelectionItemId::new("glyph-set"))
            );
            assert!(matches!(
                editor.handle_key(KeyEvent::new(key, KeyModifiers::NONE)),
                super::ConfigEditorOutcome::Action(ConfigSelectionAction::SetTerminalSettings(edit))
                    if edit.terminal.glyph_set() == expected
            ));
        }
    }
}

#[test]
fn automatic_update_policy_cycles_with_activation() {
    use crate::widgets::list_selection::ListSelectionItemId;
    for (key, expected) in [
        (KeyCode::Enter, crate::UpdatePolicy::Stable),
        (KeyCode::Char(' '), crate::UpdatePolicy::Stable),
    ] {
        let mut editor = super::ConfigEditor::new(config_choices(
            &empty_config_snapshot(),
            &providers(),
            TerminalSettings::default(),
            StatusLineSettings::default(),
        ));
        assert!(
            editor
                .selection
                .state_mut()
                .focus_item(&ListSelectionItemId::new("auto-update"))
        );
        assert!(matches!(
            editor.handle_key(KeyEvent::new(key, KeyModifiers::NONE)),
            super::ConfigEditorOutcome::Action(ConfigSelectionAction::SetUpdatePolicy(edit))
                if edit.terminal.auto_update() == expected
        ));
    }
}

#[test]
fn config_editor_shows_off_when_vim_is_disabled() {
    let mut terminal = TerminalSettings::default();
    terminal.set_input_mode(ChatInputMode::Standard);

    let view = config_choices(
        &empty_config_snapshot(),
        &providers(),
        terminal,
        StatusLineSettings::default(),
    );
    let mut state = ListSelectionState::new(view.model);

    assert_eq!(
        state.visible_items()[0].description(),
        Some("Use Vim editing in ChatInput off")
    );
    state.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    assert!(state.search().unwrap().input_active());
    state.handle_key(KeyEvent::new(KeyCode::Char('v'), KeyModifiers::NONE));
    assert_eq!(state.query(), "v");
    state.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    state.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    assert_eq!(state.active_tab().label(), "Providers");
}

#[test]
fn config_option_arrows_do_not_change_values_or_pages() {
    for key in [
        KeyEvent::new(KeyCode::Left, KeyModifiers::NONE),
        KeyEvent::new(KeyCode::Right, KeyModifiers::NONE),
    ] {
        let mut editor = super::ConfigEditor::new(config_choices(
            &empty_config_snapshot(),
            &providers(),
            TerminalSettings::default(),
            StatusLineSettings::default(),
        ));
        editor.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert!(matches!(
            editor.handle_key(key),
            super::ConfigEditorOutcome::Consumed
        ));
    }
}

#[test]
fn config_editor_shows_on_when_vim_is_enabled() {
    let mut terminal = TerminalSettings::default();
    terminal.set_input_mode(ChatInputMode::Vim);

    let view = config_choices(
        &empty_config_snapshot(),
        &providers(),
        terminal,
        StatusLineSettings::default(),
    );
    let state = ListSelectionState::new(view.model);

    assert_eq!(
        state.visible_items()[0].description(),
        Some("Use Vim editing in ChatInput on")
    );
}

#[test]
fn provider_api_key_input_is_masked_keeps_its_explanation_and_submits_with_enter() {
    let prompt = provider_api_key_prompt("openai".into(), "OpenAI".into());
    let mut state = TextPrompt::new(prompt.spec);

    state.handle_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::NONE));
    state.handle_key(KeyEvent::new(KeyCode::Char('k'), KeyModifiers::NONE));
    let outcome = state.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert!(state.input().masked());
    assert_eq!(
        state.explanation(),
        "The key is hidden and stored in the profile secret store"
    );
    assert!(matches!(
        outcome,
        TextPromptOutcome::Submit(value) if value == "sk"
    ));
    assert_eq!(prompt.provider, "openai");
}

fn custom_editor() -> super::ConfigEditor {
    let mut editor = super::ConfigEditor::new(config_choices(
        &empty_config_snapshot(),
        &providers(),
        TerminalSettings::default(),
        StatusLineSettings::default(),
    ));
    editor.selection.state_mut().focus_item(
        &crate::widgets::list_selection::ListSelectionItemId::new("new-custom-provider"),
    );
    editor.selection.handle_paste("New custom provider".into());
    editor.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    editor
}

#[test]
fn custom_form_owns_keyboard_input_and_esc_returns_to_providers() {
    let mut editor = custom_editor();
    assert!(matches!(
        editor.page(),
        super::ConfigEditorPage::Provider(_)
    ));
    editor.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    editor.handle_paste("unconfirmed-name".into());
    for _ in 0..2 {
        editor.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    }
    assert_eq!(
        editor.selection().unwrap().active_tab().label(),
        "Providers"
    );
}

#[test]
fn created_provider_autosaves_without_leaving_form_and_next_edit_uses_new_revision() {
    let mut editor = custom_editor();
    editor.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    editor.handle_paste("Example".into());
    assert!(matches!(
        editor.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        super::ConfigEditorOutcome::Consumed
    ));
    editor.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    editor.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    editor.handle_paste("https://example.test/v1".into());
    let super::ConfigEditorOutcome::Action(ConfigSelectionAction::Connection(request)) =
        editor.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("expected autosave")
    };
    let mut config = empty_config_snapshot();
    config.revision = 1;
    config
        .providers
        .insert(request.config.provider.clone(), request.config.clone());
    editor.complete_connection(crate::config::provider::Reply {
        id: request.id,
        result: Ok((
            config_choices(
                &config,
                &providers(),
                TerminalSettings::default(),
                StatusLineSettings::default(),
            ),
            None,
        )),
    });
    assert!(matches!(
        editor.page(),
        super::ConfigEditorPage::Provider(_)
    ));
    editor.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    editor.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    editor.handle_paste(" renamed".into());
    let super::ConfigEditorOutcome::Action(ConfigSelectionAction::Connection(renamed)) =
        editor.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("expected autosave")
    };
    assert_eq!(renamed.config.provider, request.config.provider);
    assert_eq!(renamed.revision, 1);
}

#[test]
fn only_custom_provider_rows_offer_delete_and_order_does_not_follow_names() {
    use ash_app_server_protocol::protocol::config::*;
    let mut config = empty_config_snapshot();
    for (id, name, order) in [("custom-a", "Zulu", 2), ("custom-b", "Alpha", 1)] {
        config.providers.insert(
            id.into(),
            ProviderConfigDto {
                provider: id.into(),
                custom: Some(CustomProviderConfigDto {
                    context_window: 272_000,
                    model: None,
                    name: name.into(),
                    protocol: CustomProviderProtocolDto::Responses,
                    order,
                }),
                base_url: Some("https://example.test".into()),
                max_output_tokens: None,
                model_context: Default::default(),
            },
        );
    }
    let mut editor = super::ConfigEditor::new(config_choices(
        &config,
        &providers(),
        TerminalSettings::default(),
        StatusLineSettings::default(),
    ));
    let id = crate::widgets::list_selection::ListSelectionItemId::new("custom-a");
    editor.selection.state_mut().focus_item(&id);
    assert_eq!(
        editor.selection().unwrap().selected_item().unwrap().label(),
        "Zulu"
    );
    assert!(editor.key_hints().text().contains("Delete"));
    assert!(
        matches!(editor.handle_key(KeyEvent::new(KeyCode::Delete, KeyModifiers::NONE)), super::ConfigEditorOutcome::Action(ConfigSelectionAction::Connection(request)) if request.operation == crate::config::provider::Operation::Remove)
    );
    editor.removing = None;
    editor.selection.state_mut().focus_item(
        &crate::widgets::list_selection::ListSelectionItemId::new("provider-api-key-openai"),
    );
    assert!(!editor.key_hints().text().contains("Delete"));
    assert!(matches!(
        editor.handle_key(KeyEvent::new(KeyCode::Delete, KeyModifiers::NONE)),
        super::ConfigEditorOutcome::Consumed
    ));
}

#[test]
fn tab_enters_the_first_item_of_each_config_page() {
    let mut editor = super::ConfigEditor::new(config_choices(
        &empty_config_snapshot(),
        &providers(),
        TerminalSettings::default(),
        StatusLineSettings::default(),
    ));
    for (code, expected_tab, expected_item) in [
        (KeyCode::Tab, "Providers", "openai-subscription"),
        (KeyCode::Tab, "Issues", "issue-refresh"),
        (KeyCode::Tab, "General", "terminal-vim-mode"),
        (KeyCode::BackTab, "Issues", "issue-refresh"),
    ] {
        assert!(matches!(
            editor.handle_key(KeyEvent::new(code, KeyModifiers::NONE)),
            super::ConfigEditorOutcome::Consumed
        ));
        let selection = editor.selection.state();
        assert_eq!(selection.active_tab().label(), expected_tab);
        assert!(selection.items_focused());
        assert_eq!(
            selection.selected_item().unwrap().id(),
            Some(&ListSelectionItemId::new(expected_item))
        );
    }
}

#[test]
fn status_line_style_changes_from_config_without_changing_items() {
    use crate::status::StatusLineStyle;
    use crate::widgets::list_selection::ListSelectionItemId;
    for language in [
        Language::English,
        Language::Chinese,
        Language::Japanese,
        Language::French,
    ] {
        for style in [StatusLineStyle::Compact, StatusLineStyle::Rich] {
            for key in [KeyCode::Enter, KeyCode::Char(' ')] {
                let mut terminal = TerminalSettings::default();
                terminal.set_language(language);
                let mut settings = StatusLineSettings::default();
                settings.set_style(style);
                let mut editor = super::ConfigEditor::new(config_choices(
                    &empty_config_snapshot(),
                    &providers(),
                    terminal,
                    settings.clone(),
                ));
                assert!(
                    editor
                        .selection
                        .state_mut()
                        .focus_item(&ListSelectionItemId::new("status-line-style"))
                );
                let super::ConfigEditorOutcome::Action(ConfigSelectionAction::SetStatusLineStyle(
                    edit,
                )) = editor.handle_key(KeyEvent::new(key, KeyModifiers::NONE))
                else {
                    panic!("expected style edit")
                };
                assert_eq!(edit.status_line.style(), style.next());
                assert_eq!(
                    edit.status_line.items().collect::<Vec<_>>(),
                    settings.items().collect::<Vec<_>>()
                );
            }
        }
    }
}

#[test]
fn reset_restores_only_the_selected_general_setting() {
    let mut terminal = TerminalSettings::default();
    terminal.set_input_mode(ChatInputMode::Vim);
    terminal.set_memory_diagnostics(true);
    terminal.set_auto_update(crate::UpdatePolicy::Never);
    terminal.set_language(Language::Chinese);
    terminal.set_key_hint_style(crate::config::KeyHintStyle::Muted);
    terminal.set_screen_mode(crate::terminal::ScreenMode::Inline);
    terminal.set_glyph_set(crate::config::GlyphSet::Plain);
    let mut status = StatusLineSettings::default();
    status.set_style(status.style().next());
    status.set_show_git_changes_as_diff(true);
    let mut config = empty_config_snapshot();
    config.revision = 42;
    config
        .tui
        .0
        .insert("unrelated".into(), serde_json::json!({"keep": true}));
    let catalog = providers();
    for (row, id) in [
        "terminal-vim-mode",
        "memory-diagnostics",
        "auto-update",
        "show-git-changes-as-diff",
        "language",
        "status-line-style",
        "key-hint-style",
        "screen-mode",
        "glyph-set",
    ]
    .into_iter()
    .enumerate()
    {
        let mut editor =
            super::ConfigEditor::new(config_choices(&config, &catalog, terminal, status.clone()));
        assert!(editor.selection.state_mut().focus_item(
            &crate::widgets::list_selection::ListSelectionItemId::new(id)
        ));
        assert!(editor.key_hints().text().contains("r reset"));
        let mut expected_terminal = terminal;
        let mut expected_status = status.clone();
        let defaults = TerminalSettings::default();
        let status_defaults = StatusLineSettings::default();
        match row {
            0 => expected_terminal.set_input_mode(defaults.input_mode()),
            1 => expected_terminal.set_memory_diagnostics(defaults.memory_diagnostics()),
            2 => expected_terminal.set_auto_update(defaults.auto_update()),
            3 => expected_status
                .set_show_git_changes_as_diff(status_defaults.show_git_changes_as_diff()),
            4 => expected_terminal.set_language(defaults.language()),
            5 => expected_status.set_style(status_defaults.style()),
            6 => expected_terminal.set_key_hint_style(defaults.key_hint_style()),
            7 => expected_terminal.set_screen_mode(defaults.screen_mode()),
            8 => expected_terminal.set_glyph_set(defaults.glyph_set()),
            _ => unreachable!(),
        }
        // A refresh and a second reset must preserve the selection and stay at the default.
        for _ in 0..2 {
            let super::ConfigEditorOutcome::Action(action) =
                editor.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::NONE))
            else {
                panic!("reset should emit an edit for row {row}")
            };
            let (ConfigSelectionAction::SetTerminalSettings(edit)
            | ConfigSelectionAction::SetVimMode(edit)
            | ConfigSelectionAction::SetLanguage(edit)
            | ConfigSelectionAction::SetUpdatePolicy(edit)
            | ConfigSelectionAction::SetShowGitChangesAsDiff(edit)
            | ConfigSelectionAction::SetStatusLineStyle(edit)) = action
            else {
                panic!("reset should use the existing save command")
            };
            assert_eq!(edit.terminal, expected_terminal);
            assert_eq!(edit.status_line, expected_status);
            assert_eq!(edit.server_config, config);
            assert_eq!(edit.providers, catalog);
            editor.replace(config_choices(
                &config,
                &catalog,
                edit.terminal,
                edit.status_line,
            ));
        }
    }
}

#[test]
fn reset_is_scoped_to_focused_settings_and_press_events() {
    let mut editor = super::ConfigEditor::new(config_choices(
        &empty_config_snapshot(),
        &providers(),
        TerminalSettings::default(),
        StatusLineSettings::default(),
    ));
    for kind in [
        crossterm::event::KeyEventKind::Repeat,
        crossterm::event::KeyEventKind::Release,
    ] {
        assert!(matches!(
            editor.handle_key(KeyEvent::new_with_kind(
                KeyCode::Char('r'),
                KeyModifiers::NONE,
                kind
            )),
            super::ConfigEditorOutcome::Consumed
        ));
    }
    editor.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));
    assert!(!editor.key_hints().text().contains("r reset"));
    assert!(matches!(
        editor.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::NONE)),
        super::ConfigEditorOutcome::Consumed
    ));
    assert_eq!(editor.selection().unwrap().search().unwrap().query(), "r");
    editor.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    assert!(!editor.key_hints().text().contains("r reset"));
    assert!(matches!(
        editor.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::NONE)),
        super::ConfigEditorOutcome::Consumed
    ));
}

#[test]
fn general_items_select_on_single_click_and_activate_on_double_click() {
    use crate::widgets::list_selection::ListSelectionClick;
    use crate::widgets::list_selection::ListSelectionItemId;
    use crate::widgets::list_selection::ListSelectionPointerTarget;
    let mut editor = super::ConfigEditor::new(config_choices(
        &empty_config_snapshot(),
        &providers(),
        TerminalSettings::default(),
        StatusLineSettings::default(),
    ));
    let memory = ListSelectionPointerTarget::Item(ListSelectionItemId::new("memory-diagnostics"));
    assert!(matches!(
        editor.handle_click(&memory, ListSelectionClick::Single),
        super::ConfigEditorOutcome::Consumed
    ));
    assert_eq!(
        editor.selection().unwrap().selected_item().unwrap().id(),
        Some(&ListSelectionItemId::new("memory-diagnostics"))
    );
    assert!(
        matches!(editor.handle_click(&memory, ListSelectionClick::Double),
        super::ConfigEditorOutcome::Action(ConfigSelectionAction::SetTerminalSettings(edit)) if edit.terminal.memory_diagnostics())
    );
    assert!(matches!(
        editor.handle_click(
            &ListSelectionPointerTarget::Search,
            ListSelectionClick::Double
        ),
        super::ConfigEditorOutcome::Consumed
    ));
}

#[test]
fn memories_master_switch_is_available_in_general_and_reset_uses_its_default() {
    let mut editor = super::ConfigEditor::new(config_choices(
        &empty_config_snapshot(),
        &providers(),
        TerminalSettings::default(),
        StatusLineSettings::default(),
    ));
    editor.selection.state_mut().focus_item(
        &crate::widgets::list_selection::ListSelectionItemId::new("memories"),
    );
    let super::ConfigEditorOutcome::Action(ConfigSelectionAction::SetMemories(edit)) =
        editor.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("memories toggle");
    };
    assert!(
        edit.server_config
            .features
            .iter()
            .find(|state| state.feature == features::Feature::Memories)
            .unwrap()
            .enabled
    );
    let super::ConfigEditorOutcome::Action(ConfigSelectionAction::SetMemories(edit)) =
        editor.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::NONE))
    else {
        panic!("memories reset");
    };
    assert!(
        !edit
            .server_config
            .features
            .iter()
            .find(|state| state.feature == features::Feature::Memories)
            .unwrap()
            .enabled
    );
}
