use super::App;
use super::AppCommand;
use crate::config::Event as ConfigEvent;
use crate::config::TerminalSettings;
use crate::terminal::ScreenMode;
use crate::thread::Command as ThreadCommand;
use crate::thread::Event as ThreadEvent;
use crate::thread::TurnActivity;
use ash_protocol::ApprovalMode;
use ash_protocol::CollaborationMode;
use ash_protocol::Turn;
use ash_protocol::TurnId;
use ash_protocol::TurnStatus;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;

fn key(app: &mut App, code: KeyCode, modifiers: KeyModifiers) -> Option<AppCommand> {
    app.handle_key(KeyEvent::new(code, modifiers))
}

fn command(app: &mut App, text: &str) -> Option<AppCommand> {
    app.insert_text(text);
    key(app, KeyCode::Enter, KeyModifiers::NONE)
}

fn switch(app: &mut App, mode: ScreenMode) {
    let mut settings = TerminalSettings::default();
    settings.set_screen_mode(mode);
    app.update(ConfigEvent::SettingsReceived(settings));
}

fn render(app: &App) -> String {
    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 24)).unwrap();
    terminal
        .draw(|frame| super::frame::draw(frame, app))
        .unwrap();
    terminal
        .backend()
        .buffer()
        .content
        .chunks(80)
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn collaboration_shortcuts_preserve_drafts_permissions_and_history_search() {
    for screen in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        let mut app = App::new();
        let root = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(
            state::SqliteMessageHistory::open(
                &root.path().join("history.sqlite3"),
                message_history::MessageHistoryRetention::default(),
            )
            .unwrap(),
        );
        app.connect_input_history(
            message_history::MessageHistory::with_waker(store, || {}).unwrap(),
        );
        switch(&mut app, screen);
        app.insert_text("keep this draft\nand this line");
        for mode in [
            CollaborationMode::Plan,
            CollaborationMode::Debug,
            CollaborationMode::Multitask,
            CollaborationMode::Ask,
            CollaborationMode::Agent,
        ] {
            assert_eq!(key(&mut app, KeyCode::BackTab, KeyModifiers::SHIFT), None);
            assert_eq!(app.collaboration_mode(), mode);
            assert_eq!(app.input(), "keep this draft\nand this line");
            assert_eq!(app.approval_mode(), ApprovalMode::AskPermissions);
        }
        for (code, modifiers, command) in [
            (
                KeyCode::Char(','),
                KeyModifiers::ALT,
                crate::models::Command::DecreaseEffort,
            ),
            (
                KeyCode::Down,
                KeyModifiers::SHIFT,
                crate::models::Command::DecreaseEffort,
            ),
            (
                KeyCode::Char('.'),
                KeyModifiers::ALT,
                crate::models::Command::IncreaseEffort,
            ),
            (
                KeyCode::Up,
                KeyModifiers::SHIFT,
                crate::models::Command::IncreaseEffort,
            ),
        ] {
            assert_eq!(
                key(&mut app, code, modifiers),
                Some(AppCommand::Models(command))
            );
            assert_eq!(app.input(), "keep this draft\nand this line");
            assert_eq!(app.approval_mode(), ApprovalMode::AskPermissions);
        }
        key(&mut app, KeyCode::Char('r'), KeyModifiers::CONTROL);
        assert!(app.input_state().searching_history());
        for (code, modifiers) in [
            (KeyCode::Char(','), KeyModifiers::ALT),
            (KeyCode::Char('.'), KeyModifiers::ALT),
            (KeyCode::Up, KeyModifiers::SHIFT),
            (KeyCode::Down, KeyModifiers::SHIFT),
        ] {
            assert_eq!(key(&mut app, code, modifiers), None);
            assert!(app.input_state().searching_history());
        }
        assert_eq!(app.collaboration_mode(), CollaborationMode::Agent);
        key(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        key(&mut app, KeyCode::BackTab, KeyModifiers::SHIFT);
        assert_eq!(app.collaboration_mode(), CollaborationMode::Plan);
        assert_eq!(app.input(), "keep this draft\nand this line");
    }
}

#[test]
fn collaboration_effort_shortcuts_leave_open_selectors_in_control() {
    for screen in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        let mut app = App::new();
        switch(&mut app, screen);
        command(&mut app, "/mode");
        app.insert_text("keep this draft");
        for (code, modifiers) in [
            (KeyCode::Char(','), KeyModifiers::ALT),
            (KeyCode::Char('.'), KeyModifiers::ALT),
            (KeyCode::Up, KeyModifiers::SHIFT),
            (KeyCode::Down, KeyModifiers::SHIFT),
        ] {
            assert_eq!(key(&mut app, code, modifiers), None);
            assert!(app.command_panel().is_some());
            assert_eq!(app.input(), "keep this draft");
        }
        key(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert!(app.chat_input_focused());
        assert!(app.command_panel().is_none());
        assert!(app.completion().is_none());
        assert_eq!(
            key(&mut app, KeyCode::Up, KeyModifiers::SHIFT),
            Some(AppCommand::Models(crate::models::Command::IncreaseEffort)),
            "{screen:?}: {:?}",
            app.app_keymap_context(true)
        );
        let mut app = App::new();
        switch(&mut app, screen);
        app.insert_text("/mod");
        assert!(app.completion().is_some());
        for (code, modifiers) in [
            (KeyCode::Char(','), KeyModifiers::ALT),
            (KeyCode::Char('.'), KeyModifiers::ALT),
            (KeyCode::Up, KeyModifiers::SHIFT),
            (KeyCode::Down, KeyModifiers::SHIFT),
        ] {
            assert_eq!(key(&mut app, code, modifiers), None);
            assert_eq!(app.input(), "/mod");
        }
    }
}

#[test]
fn collaboration_effort_boundaries_are_localized_not_added_to_the_transcript() {
    for screen in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        let mut app = App::new();
        let mut settings = TerminalSettings::default();
        settings.set_screen_mode(screen);
        settings.set_language(crate::nls::Language::Chinese);
        app.update(ConfigEvent::SettingsReceived(settings));
        app.insert_text("keep this draft");
        let rows = app.messages().len();
        let mut config = crate::test_support::empty_config_snapshot();
        config.model = Some(ash_app_server_protocol::protocol::config::ModelRefDto {
            provider: "openai".into(),
            model: "test-model".into(),
        });
        config.model_reasoning_effort = Some(ash_protocol::ReasoningEffort::High);
        let origin = super::requests::RequestOrigin {
            mode: screen,
            panel_generation: app.panels().generation(),
        };
        for (command, message, expected) in [
            (
                crate::models::Command::DecreaseEffort,
                "Thinking effort is already at the lowest level ({0})",
                "推理强度已是最低档（high）",
            ),
            (
                crate::models::Command::IncreaseEffort,
                "Thinking effort is already at the highest level ({0})",
                "推理强度已是最高档（high）",
            ),
        ] {
            super::completion::apply_request_completion(
                super::completion::Completion::ModelUpdated {
                    command,
                    result: Ok(crate::models::ModelUpdate {
                        summary: crate::models::ModelSummary::from_catalog(
                            config.model.clone(),
                            config.model_reasoning_effort,
                            None,
                        ),
                        notice: crate::models::ModelNotice::ThinkingEffort(
                            crate::nls::Text::template(message, vec!["high".into()]),
                        ),
                        picker: None,
                        config: config.clone(),
                    }),
                },
                origin,
                &mut None,
                &mut app,
                &ash_app_server_protocol::protocol::model::ModelListResult { models: vec![] },
            );
            assert_eq!(app.messages().len(), rows);
            assert_eq!(app.input(), "keep this draft");
            let rendered = render(&app);
            assert!(
                rendered.replace(' ', "").contains(expected),
                "{screen:?}: expected {expected}\n{rendered}"
            );
        }
        match screen {
            ScreenMode::Fullscreen => {
                crate::tui_assert_snapshot!("effort_boundary_fullscreen_chinese", render(&app))
            }
            ScreenMode::Inline => {
                crate::tui_assert_snapshot!("effort_boundary_inline_chinese", render(&app))
            }
        }
    }
}

#[test]
fn collaboration_mode_commands_use_protocol_ids_in_every_language() {
    for screen in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        for language in [
            crate::nls::Language::English,
            crate::nls::Language::Japanese,
            crate::nls::Language::Chinese,
            crate::nls::Language::French,
        ] {
            let mut app = App::new();
            let mut settings = TerminalSettings::default();
            settings.set_screen_mode(screen);
            settings.set_language(language);
            app.update(ConfigEvent::SettingsReceived(settings));
            for (id, mode) in [
                ("agent", CollaborationMode::Agent),
                ("plan", CollaborationMode::Plan),
                ("debug", CollaborationMode::Debug),
                ("multitask", CollaborationMode::Multitask),
                ("ask", CollaborationMode::Ask),
            ] {
                assert_eq!(serde_json::to_value(mode).unwrap(), id);
                for argument in [id.to_owned(), id.to_ascii_uppercase()] {
                    if app.collaboration_mode() == mode {
                        key(&mut app, KeyCode::BackTab, KeyModifiers::SHIFT);
                    }
                    assert_ne!(app.collaboration_mode(), mode);
                    assert_eq!(command(&mut app, &format!("/mode {argument}")), None);
                    assert_eq!(app.collaboration_mode(), mode);
                    assert_eq!(app.approval_mode(), ApprovalMode::AskPermissions);
                    assert!(app.input().is_empty());
                    assert!(app.command_panel().is_none());
                    assert!(app.chat_input_focused());
                }
            }
            for argument in ["计划", "計画", "custom/example", "unknown"] {
                assert_eq!(command(&mut app, &format!("/mode {argument}")), None);
                assert_eq!(app.collaboration_mode(), CollaborationMode::Ask);
                assert!(app.chat_input_focused());
            }
        }
    }
}

#[test]
fn collaboration_selector_selects_and_dismisses_in_both_screens() {
    for screen in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        let mut app = App::new();
        switch(&mut app, screen);
        assert_eq!(command(&mut app, "/mode debug"), None);
        assert_eq!(command(&mut app, "/mode"), None);
        assert_eq!(
            app.list_selection().unwrap().selected_visible_index(),
            Some(2)
        );
        app.insert_text("draft behind selector");
        match screen {
            ScreenMode::Fullscreen => {
                crate::tui_assert_snapshot!("collaboration_fullscreen_selector", render(&app))
            }
            ScreenMode::Inline => {
                crate::tui_assert_snapshot!("collaboration_inline_selector", render(&app))
            }
        }
        key(&mut app, KeyCode::Down, KeyModifiers::NONE);
        key(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(app.collaboration_mode(), CollaborationMode::Multitask);
        assert!(app.command_panel().is_none());
        assert!(app.chat_input_focused());
        assert_eq!(app.input(), "draft behind selector");
        match screen {
            ScreenMode::Fullscreen => {
                crate::tui_assert_snapshot!("collaboration_fullscreen_selected", render(&app))
            }
            ScreenMode::Inline => {
                crate::tui_assert_snapshot!("collaboration_inline_selected", render(&app))
            }
        }
        switch(
            &mut app,
            if screen == ScreenMode::Inline {
                ScreenMode::Fullscreen
            } else {
                ScreenMode::Inline
            },
        );
        assert_eq!(app.collaboration_mode(), CollaborationMode::Multitask);
    }
}

#[test]
fn collaboration_policy_and_effort_commands_are_independent() {
    let mut app = App::new();
    app.open_home();
    command(&mut app, "/mode ask");
    command(&mut app, "/policy auto-review");
    assert_eq!(app.collaboration_mode(), CollaborationMode::Ask);
    assert_eq!(app.approval_mode(), ApprovalMode::AutoReview);
    assert_eq!(
        command(&mut app, "/effort high"),
        Some(AppCommand::Models(crate::models::Command::SetEffort {
            effort: ash_protocol::ReasoningEffort::High
        }))
    );
    assert_eq!(
        command(&mut app, "/effort"),
        Some(AppCommand::Models(crate::models::Command::OpenEffortPicker))
    );
    command(&mut app, "/mode unknown");
    assert_eq!(app.collaboration_mode(), CollaborationMode::Ask);
    assert!(render(&app).contains("Use /mode agent|plan|debug|multitask|ask"));
    crate::tui_assert_snapshot!("collaboration_option_error_on_home", render(&app));
    command(&mut app, "/policy");
    assert_eq!(
        app.list_selection().unwrap().selected_visible_index(),
        Some(1)
    );
    key(&mut app, KeyCode::Esc, KeyModifiers::NONE);
    assert_eq!(app.collaboration_mode(), CollaborationMode::Ask);
    assert_eq!(app.approval_mode(), ApprovalMode::AutoReview);
}

#[test]
fn collaboration_effort_selector_applies_a_supported_value_and_restores_focus() {
    use ash_protocol::ReasoningEffort;
    let mut config = crate::test_support::empty_config_snapshot();
    config.model = Some(ash_app_server_protocol::protocol::config::ModelRefDto {
        provider: "openai".into(),
        model: "test-model".into(),
    });
    config.model_reasoning_effort = Some(ReasoningEffort::High);
    let catalog = ash_app_server_protocol::protocol::model::ModelListResult {
        models: vec![
            ash_app_server_protocol::protocol::model::ModelCatalogEntry {
                model: ash_protocol::ModelRef::new(
                    ash_protocol::ProviderId::new("openai").unwrap(),
                    ash_protocol::ModelId::new("test-model").unwrap(),
                ),
                display_name: "Test Model".into(),
                context_window: None,
                auto_compact_token_limit: None,
                available_context_window: None,
                capabilities: ash_protocol::ModelCapabilities::UNKNOWN,
                supported_reasoning_efforts: vec![
                    ReasoningEffort::Low,
                    ReasoningEffort::High,
                    ReasoningEffort::Max,
                ],
                model_reasoning_effort: Some(ReasoningEffort::Low),
                default_personality: None,
            },
        ],
    };
    let data = crate::models::ModelPickerData::new(catalog, config);
    let mut app = App::new();
    assert_eq!(
        command(&mut app, "/effort"),
        Some(AppCommand::Models(crate::models::Command::OpenEffortPicker))
    );
    app.open_command_panel(super::command_panel::CommandPanel::composer_options(
        data.effort_choices().unwrap(),
    ));
    assert_eq!(
        app.list_selection().unwrap().selected_visible_index(),
        Some(1)
    );
    crate::tui_assert_snapshot!("collaboration_effort_selector", render(&app));
    key(&mut app, KeyCode::Down, KeyModifiers::NONE);
    assert_eq!(
        key(&mut app, KeyCode::Enter, KeyModifiers::NONE),
        Some(AppCommand::Models(crate::models::Command::SetEffort {
            effort: ReasoningEffort::Max
        }))
    );
    assert!(app.chat_input_focused());
    assert!(app.command_panel().is_none());
}

#[test]
fn collaboration_inline_statusline_can_be_enabled_and_localized() {
    use crate::status::StatusLineItem;
    use crate::status::StatusLineSettings;
    let mut app = App::new();
    let mut settings = TerminalSettings::default();
    settings.set_screen_mode(ScreenMode::Inline);
    settings.set_language(crate::nls::Language::Chinese);
    app.update(ConfigEvent::SettingsReceived(settings));
    app.update(crate::models::Event::SummaryReceived(
        crate::models::ModelSummary::from_catalog(None, None, None),
    ));
    let mut statusline = StatusLineSettings::default();
    for item in StatusLineItem::ALL {
        statusline.set(
            item,
            matches!(item, StatusLineItem::Model | StatusLineItem::Mode),
        );
    }
    app.update(crate::status::Event::LineSettingsReceived(
        statusline.clone(),
    ));
    app.chat_panel.reset_top_tip();
    assert_eq!(
        app.status_line()
            .top_text_for_width(78, app.status_line_runtime()),
        "Automatic model"
    );
    crate::tui_assert_snapshot!(
        "collaboration_inline_default_statusline_chinese",
        render(&app)
    );
    command(&mut app, "/mode plan");
    app.chat_panel.reset_top_tip();
    let output = render(&app);
    assert!(
        app.status_line()
            .top_text_for_width(78, app.status_line_runtime())
            .contains("计划")
    );
    crate::tui_assert_snapshot!("collaboration_inline_statusline_chinese", output);
    statusline.set(StatusLineItem::Mode, false);
    app.update(crate::status::Event::LineSettingsReceived(statusline));
    app.chat_panel.reset_top_tip();
    assert!(
        !app.status_line()
            .top_text_for_width(78, app.status_line_runtime())
            .contains("计划")
    );
    command(&mut app, "/mode");
    assert_eq!(
        app.list_selection().unwrap().selected_visible_index(),
        Some(1)
    );
    crate::tui_assert_snapshot!("collaboration_selector_chinese", render(&app));
}

fn running_turn(mode: CollaborationMode) -> Turn {
    Turn {
        mode,
        advisor: None,
        turn_id: TurnId::new("running").unwrap(),
        status: TurnStatus::Running,
        kind: Default::default(),
        instructions: None,
        model: None,
        reasoning_effort: None,
        tool_profile: None,
        tool_mode: ash_protocol::ToolMode::Direct,
        approval_mode: ApprovalMode::AskPermissions,
        usage: Default::default(),
        context_usage: None,
        items: vec![],
        plan: None,
        pending_interaction: None,
        error: None,
    }
}

#[test]
fn collaboration_changed_during_a_turn_is_queued_instead_of_steered() {
    let mut app = App::new();
    let turn = running_turn(CollaborationMode::Debug);
    app.sync_active_turn(&[turn.clone()]);
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Working));
    assert_eq!(app.collaboration_mode(), CollaborationMode::Debug);
    command(&mut app, "/mode invalid");
    assert_eq!(app.status(), &super::Status::Working);
    assert!(app.steers_active_turn());
    app.update(ThreadEvent::CommandCompleted {
        command: "/effort".into(),
        result: "Thinking effort: high".into(),
    });
    assert_eq!(app.status(), &super::Status::Working);
    assert!(app.steers_active_turn());
    command(&mut app, "/mode plan");
    app.sync_active_turn(&[turn]);
    assert_eq!(app.collaboration_mode(), CollaborationMode::Plan);
    let previous_rows = app.messages().len();
    app.insert_text("plan the next task");
    let Some(AppCommand::Thread(ThreadCommand::Enqueue { submission, .. })) =
        key(&mut app, KeyCode::Enter, KeyModifiers::CONTROL)
    else {
        panic!("a different mode must start a queued turn")
    };
    assert_eq!(submission.mode, CollaborationMode::Plan);
    assert_eq!(app.messages().len(), previous_rows);
    assert_eq!(app.queue_view().items[0].text, "plan the next task");
}
