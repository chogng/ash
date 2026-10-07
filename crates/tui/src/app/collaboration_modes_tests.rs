use super::App;
use super::AppCommand;
use crate::config::Event as ConfigEvent;
use crate::config::TerminalSettings;
use crate::keymap::KeyEvent;
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

fn frame_text(buffer: &ratatui::buffer::Buffer) -> String {
    crate::terminal::text::text_in_range(
        buffer,
        crate::terminal::text::ScreenSelectionRange::new(
            buffer.area.as_position(),
            ratatui::layout::Position::new(buffer.area.right() - 1, buffer.area.bottom() - 1),
        ),
    )
    .unwrap()
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
            assert_eq!(app.approval_mode(), ApprovalMode::Manual);
            assert_eq!(app.top_tip().text(None), None);
        }
        for (code, modifiers, command) in [
            (
                KeyCode::Down,
                KeyModifiers::SHIFT,
                crate::models::Command::DecreaseEffort,
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
            assert_eq!(app.approval_mode(), ApprovalMode::Manual);
        }
        key(&mut app, KeyCode::Char('r'), KeyModifiers::CONTROL);
        assert!(app.input_state().searching_history());
        for (code, modifiers) in [
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
            (KeyCode::Up, KeyModifiers::SHIFT),
            (KeyCode::Down, KeyModifiers::SHIFT),
        ] {
            assert_eq!(key(&mut app, code, modifiers), None);
            assert_eq!(app.input(), "/mod");
        }
    }
}

#[test]
fn collaboration_effort_changes_update_status_without_a_notice() {
    use ash_protocol::ReasoningEffort;
    for screen in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        let mut app = App::new();
        let mut settings = TerminalSettings::default();
        settings.set_screen_mode(screen);
        settings.set_language(crate::nls::Language::Chinese);
        app.update(ConfigEvent::SettingsReceived(settings));
        app.insert_text("keep this draft");
        let rows = app.messages().len();
        let origin = super::requests::RequestOrigin {
            mode: screen,
            panel_generation: app.panels().generation(),
        };
        for (command, effort) in [
            (
                crate::models::Command::IncreaseEffort,
                ReasoningEffort::High,
            ),
            (crate::models::Command::DecreaseEffort, ReasoningEffort::Low),
            (
                crate::models::Command::SetEffort {
                    effort: ReasoningEffort::Max,
                },
                ReasoningEffort::Max,
            ),
        ] {
            let mut config = crate::test_support::empty_config_snapshot();
            config.model = Some(ash_app_server_protocol::protocol::config::ModelRefDto {
                provider: "openai".into(),
                model: "test-model".into(),
            });
            config.model_reasoning_effort = Some(effort);
            super::completion::apply_request_completion(
                super::completion::Completion::ModelUpdated {
                    command,
                    result: Ok(crate::models::ModelUpdate {
                        catalog: None,
                        summary: crate::models::ModelSummary::from_catalog(
                            config.model.clone(),
                            config.model_reasoning_effort,
                            None,
                        ),
                        notice: crate::models::ModelNotice::Silent,
                        picker: None,
                        config,
                    }),
                },
                origin,
                &mut None,
                &mut app,
            );
            assert_eq!(
                app.status_line().model_label(),
                format!("test-model ({})", effort.as_str())
            );
            assert_eq!(app.top_tip().text(None), None);
            assert_eq!(app.messages().len(), rows);
            assert_eq!(app.input(), "keep this draft");
            assert!(app.chat_input_focused());
        }
        match screen {
            ScreenMode::Fullscreen => {
                crate::tui_assert_snapshot!(app = &app; "effort_changed_fullscreen_chinese", render(&app))
            }
            ScreenMode::Inline => {
                crate::tui_assert_snapshot!(app = &app; "effort_changed_inline_chinese", render(&app))
            }
        }
    }
}

#[test]
fn collaboration_effort_boundaries_are_silent_in_both_modes() {
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
        for command in [
            crate::models::Command::DecreaseEffort,
            crate::models::Command::IncreaseEffort,
        ] {
            super::completion::apply_request_completion(
                super::completion::Completion::ModelUpdated {
                    command,
                    result: Ok(crate::models::ModelUpdate {
                        catalog: None,
                        summary: crate::models::ModelSummary::from_catalog(
                            config.model.clone(),
                            config.model_reasoning_effort,
                            None,
                        ),
                        notice: crate::models::ModelNotice::Silent,
                        picker: None,
                        config: config.clone(),
                    }),
                },
                origin,
                &mut None,
                &mut app,
            );
            assert_eq!(app.messages().len(), rows);
            assert_eq!(app.input(), "keep this draft");
            assert_eq!(app.status_line().model_label(), "test-model (high)");
            assert_eq!(app.top_tip().text(None), None);
            assert!(app.chat_input_focused());
        }
        match screen {
            ScreenMode::Fullscreen => {
                crate::tui_assert_snapshot!(app = &app; "effort_boundary_fullscreen_chinese", render(&app))
            }
            ScreenMode::Inline => {
                crate::tui_assert_snapshot!(app = &app; "effort_boundary_inline_chinese", render(&app))
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
                    assert_eq!(app.approval_mode(), ApprovalMode::Manual);
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
                crate::tui_assert_snapshot!(app = &app; "collaboration_fullscreen_selector", render(&app))
            }
            ScreenMode::Inline => {
                crate::tui_assert_snapshot!(app = &app; "collaboration_inline_selector", render(&app))
            }
        }
        key(&mut app, KeyCode::Down, KeyModifiers::NONE);
        key(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(app.collaboration_mode(), CollaborationMode::Multitask);
        assert!(app.command_panel().is_none());
        assert!(app.chat_input_focused());
        assert_eq!(app.input(), "draft behind selector");
        assert_eq!(app.top_tip().text(None), None);
        match screen {
            ScreenMode::Fullscreen => {
                crate::tui_assert_snapshot!(app = &app; "collaboration_fullscreen_selected", render(&app))
            }
            ScreenMode::Inline => {
                crate::tui_assert_snapshot!(app = &app; "collaboration_inline_selected", render(&app))
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
    command(&mut app, "/permission auto");
    assert_eq!(app.collaboration_mode(), CollaborationMode::Ask);
    assert_eq!(app.approval_mode(), ApprovalMode::Auto);
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
    crate::tui_assert_snapshot!(app = &app; "collaboration_option_error_on_home", render(&app));
    command(&mut app, "/permission");
    assert_eq!(
        app.list_selection().unwrap().selected_visible_index(),
        Some(0)
    );
    key(&mut app, KeyCode::Esc, KeyModifiers::NONE);
    assert_eq!(app.collaboration_mode(), CollaborationMode::Ask);
    assert_eq!(app.approval_mode(), ApprovalMode::Auto);
}

#[test]
fn cooperation_aliases_use_ash_multitask_without_changing_effort() {
    use ash_protocol::ReasoningEffort;
    for screen in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        for language in [crate::nls::Language::English, crate::nls::Language::Chinese] {
            let mut app = App::new();
            let mut settings = TerminalSettings::default();
            settings.set_screen_mode(screen);
            settings.set_language(language);
            app.update(ConfigEvent::SettingsReceived(settings));
            app.update(crate::models::Event::SummaryReceived(
                crate::models::ModelSummary::from_catalog(
                    Some(ash_app_server_protocol::protocol::config::ModelRefDto {
                        provider: "openai".into(),
                        model: "test-model".into(),
                    }),
                    Some(ReasoningEffort::High),
                    None,
                ),
            ));
            for alias in ["multitask", "ULTRA", "ultracode"] {
                command(&mut app, "/mode plan");
                assert_eq!(command(&mut app, &format!("/effort {alias}")), None);
                assert_eq!(app.collaboration_mode(), CollaborationMode::Multitask);
                assert_eq!(app.status_line().model_label(), "test-model (high)");
                assert_eq!(app.approval_mode(), ApprovalMode::Manual);
                assert!(app.chat_input_focused());
                assert!(app.input().is_empty());
                assert!(app.command_panel().is_none());
                assert_eq!(command(&mut app, &format!("/effort {alias} off")), None);
                assert_eq!(app.collaboration_mode(), CollaborationMode::Agent);
                command(&mut app, "/mode plan");
                command(&mut app, &format!("/effort {alias} off"));
                assert_eq!(app.collaboration_mode(), CollaborationMode::Plan);
            }
            command(&mut app, "/effort ultracode on");
            assert_eq!(
                command(&mut app, "/effort high"),
                Some(AppCommand::Models(crate::models::Command::SetEffort {
                    effort: ReasoningEffort::High
                }))
            );
            assert_eq!(app.collaboration_mode(), CollaborationMode::Multitask);
            // Keep the snapshot focused on the final acknowledgement, rather than the matrix.
            app.update(ThreadEvent::TranscriptCleared);
            command(&mut app, "/effort ultra on");
            match (screen, language) {
                (ScreenMode::Fullscreen, crate::nls::Language::English) => {
                    crate::tui_assert_snapshot!(app = &app; "cooperation_alias_fullscreen", render_effort(&app));
                }
                (ScreenMode::Inline, crate::nls::Language::Chinese) => {
                    // Inline commits notices above the live viewport, through the history renderer.
                    assert_eq!(app.history_prefix().len(), 1);
                    let view = app.history_prefix()[0].history_view();
                    let context = app.render_context();
                    let cache = app.transcript_render_cache();
                    let mut buffer = ratatui::buffer::Buffer::empty(ratatui::layout::Rect::new(
                        0,
                        0,
                        80,
                        view.height(80, context, cache) as u16,
                    ));
                    view.render_rows(&mut buffer, 0, context, cache);
                    let history = buffer
                        .content
                        .chunks(80)
                        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
                        .collect::<Vec<_>>()
                        .join("\n");
                    crate::tui_assert_snapshot!(app = &app; "cooperation_alias_inline_chinese", format!("{history}\n{}", render_effort(&app)));
                }
                _ => {}
            }
            command(&mut app, "/mode plan");
            for value in ["ultra unknown", "ultracode on extra", "max on"] {
                assert_eq!(command(&mut app, &format!("/effort {value}")), None);
                assert_eq!(app.collaboration_mode(), CollaborationMode::Plan);
                assert_eq!(app.status_line().model_label(), "test-model (high)");
            }
        }
    }
}

#[test]
fn cooperation_alias_during_a_turn_only_changes_the_next_submission() {
    let mut app = App::new();
    let turn = running_turn(CollaborationMode::Debug);
    app.sync_active_turn(&[turn.clone()]);
    app.update(ThreadEvent::TurnActivityChanged(TurnActivity::Working));
    assert_eq!(command(&mut app, "/effort ultra"), None);
    assert_eq!(app.status(), &super::Status::Working);
    app.sync_active_turn(&[turn]);
    assert_eq!(app.collaboration_mode(), CollaborationMode::Multitask);
    app.insert_text("execute the next task");
    let Some(AppCommand::Thread(ThreadCommand::Enqueue { submission, .. })) =
        key(&mut app, KeyCode::Enter, KeyModifiers::CONTROL)
    else {
        panic!("the new cooperation mode must submit a separate queued task")
    };
    assert_eq!(submission.mode, CollaborationMode::Multitask);
    assert_eq!(serde_json::to_value(submission.mode).unwrap(), "multitask");
    assert_eq!(app.queue_view().items[0].text, "execute the next task");
}

#[test]
fn permission_menu_uses_shared_copy_and_the_same_ids_in_both_screens() {
    for screen in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        let mut app = App::new();
        app.open_home();
        let mut settings = TerminalSettings::default();
        settings.set_language(crate::nls::Language::Chinese);
        settings.set_screen_mode(screen);
        app.update(ConfigEvent::SettingsReceived(settings));
        command(&mut app, "/mode plan");
        command(&mut app, "/permission");
        assert_eq!(
            app.list_selection().unwrap().selected_visible_index(),
            Some(1)
        );
        key(&mut app, KeyCode::Down, KeyModifiers::NONE);
        key(&mut app, KeyCode::Right, KeyModifiers::NONE);
        let visible = render(&app);
        match screen {
            ScreenMode::Fullscreen => {
                crate::tui_assert_snapshot!(app = &app; "permission_menu_fullscreen_chinese", visible)
            }
            ScreenMode::Inline => {
                crate::tui_assert_snapshot!(app = &app; "permission_menu_inline_chinese", visible)
            }
        }
        key(&mut app, KeyCode::Home, KeyModifiers::NONE);
        key(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(app.approval_mode(), ApprovalMode::Auto);
        assert_eq!(app.collaboration_mode(), CollaborationMode::Plan);
        for (id, mode) in [
            ("manual", ApprovalMode::Manual),
            ("auto", ApprovalMode::Auto),
            ("bypassPermissions", ApprovalMode::BypassPermissions),
        ] {
            command(&mut app, &format!("/permission {id}"));
            assert_eq!(app.approval_mode(), mode);
            assert_eq!(app.collaboration_mode(), CollaborationMode::Plan);
        }
    }
}

#[test]
fn collaboration_effort_selector_applies_a_supported_value_and_restores_focus() {
    use ash_protocol::ReasoningEffort;
    let data = effort_data();
    let mut app = App::new();
    assert_eq!(
        command(&mut app, "/effort"),
        Some(AppCommand::Models(crate::models::Command::OpenEffortPicker))
    );
    app.open_command_panel(super::command_panel::CommandPanel::Effort(
        data.effort_selector(app.collaboration_mode()).unwrap(),
    ));
    assert!(matches!(
        app.command_panel(),
        Some(super::command_panel::CommandPanel::Effort(_))
    ));
    crate::tui_assert_snapshot!(app = &app; "collaboration_effort_selector", render_effort(&app));
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
fn effort_selector_title_shares_the_separator_in_both_screen_modes() {
    use ratatui::style::Modifier;

    for screen in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        for (language, title) in [
            (crate::nls::Language::English, "Thinking effort"),
            (crate::nls::Language::Chinese, "推理强度"),
        ] {
            for width in [40, 80] {
                let mut app = App::new();
                let mut settings = TerminalSettings::default();
                settings.set_screen_mode(screen);
                settings.set_language(language);
                app.update(ConfigEvent::SettingsReceived(settings));
                app.insert_text("keep this draft");
                app.open_command_panel(super::command_panel::CommandPanel::Effort(
                    effort_data()
                        .effort_selector(app.collaboration_mode())
                        .unwrap(),
                ));
                let mut terminal =
                    ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, 24)).unwrap();
                terminal
                    .draw(|frame| super::frame::draw(frame, &app))
                    .unwrap();
                let buffer = terminal.backend().buffer();
                let text = frame_text(buffer);
                let rows: Vec<_> = text.lines().collect();
                let title_y = rows.iter().position(|row| row.contains(title)).unwrap();
                assert!(rows[title_y].starts_with(&format!("─ {title} ")));
                assert!(rows[title_y].ends_with('─'));
                assert!(rows[title_y + 1].trim().is_empty());
                let cell = &buffer[(2, title_y as u16)];
                assert_eq!(cell.fg, app.render_context().focus());
                assert!(cell.modifier.contains(Modifier::BOLD));
                if screen == ScreenMode::Fullscreen {
                    for y in title_y as u16 + 1..24 {
                        assert_eq!(buffer[(0, y)].symbol(), " ");
                        assert_eq!(buffer[(width - 1, y)].symbol(), " ");
                    }
                }
                if screen == ScreenMode::Inline
                    && language == crate::nls::Language::Chinese
                    && width == 40
                {
                    crate::tui_assert_snapshot!(app = &app; "effort_selector_inline_narrow_chinese_header", text);
                }
                app.handle_key_in_area(
                    KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
                    buffer.area,
                );
                assert!(app.command_panel().is_none());
                assert!(app.chat_input_focused());
                assert_eq!(app.input(), "keep this draft");
            }
        }
    }
}

#[test]
fn fullscreen_effort_drag_copy_keeps_tip_above_panel_and_hints_below() {
    use crossterm::event::MouseButton;
    use crossterm::event::MouseEvent;
    use crossterm::event::MouseEventKind;
    use ratatui::layout::Position;
    use ratatui::layout::Rect;

    for (language, label, suffix) in [
        (crate::nls::Language::English, "Faster", "english"),
        (crate::nls::Language::Chinese, "更快", "chinese"),
    ] {
        let mut app = App::new();
        let mut settings = TerminalSettings::default();
        settings.set_language(language);
        app.update(ConfigEvent::SettingsReceived(settings));
        app.insert_text("keep this draft");
        app.open_command_panel(super::command_panel::CommandPanel::Effort(
            effort_data()
                .effort_selector(app.collaboration_mode())
                .unwrap(),
        ));
        let area = Rect::new(0, 0, 80, 24);
        let areas = super::fullscreen::layout(&app, area).session;
        assert_eq!(areas.tipline.height, 1);
        assert_eq!(areas.transcript.bottom(), areas.tipline.y);
        assert_eq!(areas.footer.hintline.bottom(), area.bottom());
        assert!(areas.composer.is_empty());
        assert!(areas.footer.statusline.is_empty());
        assert!(areas.agent_thread_switcher.is_empty());

        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 24)).unwrap();
        terminal
            .draw(|frame| super::frame::draw(frame, &app))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let first_char = label.chars().next().unwrap().to_string();
        let index = buffer
            .content
            .iter()
            .position(|cell| cell.symbol() == first_char)
            .unwrap() as u16;
        let start = Position::new(index % 80, index / 80);
        let end = Position::new(
            start.x + crate::render::display_width(label) as u16 - 1,
            start.y,
        );
        let mouse = |kind, position: Position| MouseEvent {
            kind,
            column: position.x,
            row: position.y,
            modifiers: KeyModifiers::NONE,
        };
        for (kind, position) in [
            (MouseEventKind::Down(MouseButton::Left), start),
            (MouseEventKind::Drag(MouseButton::Left), end),
        ] {
            super::fullscreen::pointer::handle_mouse(&mut app, area, mouse(kind, position));
        }
        let super::fullscreen::pointer::MouseAction::Selection(Some(
            super::fullscreen::selection::ScreenSelectionOutcome::Selection(range),
        )) = super::fullscreen::pointer::handle_mouse(
            &mut app,
            area,
            mouse(MouseEventKind::Up(MouseButton::Left), end),
        )
        else {
            panic!("dragging the effort description must select text");
        };
        let text = crate::terminal::text::text_in_range(buffer, range).unwrap();
        assert_eq!(text, label);
        let mut copied = None;
        super::fullscreen::selection::apply_copied_text(&mut app, &text, |text| {
            copied = Some(text.to_owned());
            Ok(())
        });
        assert_eq!(copied.as_deref(), Some(label));
        let notice = format!("Copied {} chars to clipboard", label.chars().count());
        assert_eq!(app.top_tip().text(None), Some(notice.as_str()));
        let notice = crate::nls::localize(language, &notice).into_owned();
        terminal
            .draw(|frame| super::frame::draw(frame, &app))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let row_text = |y| {
            crate::terminal::text::text_in_range(
                buffer,
                crate::terminal::text::ScreenSelectionRange::new(
                    Position::new(0, y),
                    Position::new(79, y),
                ),
            )
            .unwrap()
        };
        assert!(row_text(areas.tipline.y).trim_end().ends_with(&notice));
        assert!(!row_text(areas.footer.hintline.y).contains(&notice));
        assert!(row_text(areas.footer.hintline.y).contains("Enter"));
        assert!(row_text(areas.footer.hintline.y).contains("Esc"));
        assert_eq!(
            buffer[start].bg,
            app.render_context().screen_selection_background()
        );
        assert_ne!(buffer[(start.x, areas.tipline.y)].bg, buffer[start].bg);
        assert_eq!(app.input(), "keep this draft");
        assert!(app.command_panel().is_some());
        crate::tui_assert_snapshot!(app = &app; format!("effort_selector_drag_copy_{suffix}"), frame_text(buffer));

        for (width, height) in [(40, 24), (80, 12), (40, 12), (40, 9)] {
            let area = Rect::new(0, 0, width, height);
            let areas = super::fullscreen::layout(&app, area);
            assert_eq!(areas.session.tipline.height, 1);
            assert!(areas.session.tipline.y >= areas.top_statusline.bottom());
            assert_eq!(areas.session.transcript.bottom(), areas.session.tipline.y);
            let mut terminal =
                ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, height)).unwrap();
            terminal
                .draw(|frame| super::frame::draw(frame, &app))
                .unwrap();
            let buffer = terminal.backend().buffer();
            let tip = crate::terminal::text::text_in_range(
                buffer,
                crate::terminal::text::ScreenSelectionRange::new(
                    Position::new(0, areas.session.tipline.y),
                    Position::new(width - 1, areas.session.tipline.y),
                ),
            )
            .unwrap();
            assert!(tip.trim_end().ends_with(&notice));
            if width == 40 && height == 24 {
                crate::tui_assert_snapshot!(app = &app; format!("effort_selector_drag_copy_narrow_{suffix}"), frame_text(buffer));
            }
        }
        key(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert!(app.command_panel().is_none());
        assert!(app.chat_input_focused());
        assert_eq!(app.input(), "keep this draft");
        let areas = super::fullscreen::layout(&app, area).session;
        assert_eq!(areas.tipline.bottom(), areas.composer.y);
        terminal
            .draw(|frame| super::frame::draw(frame, &app))
            .unwrap();
        crate::tui_assert_snapshot!(app = &app; format!("effort_selector_copy_close_restores_draft_{suffix}"), frame_text(terminal.backend().buffer()));
    }
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
        app = &app;
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
    crate::tui_assert_snapshot!(app = &app; "collaboration_inline_statusline_chinese", output);
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
    crate::tui_assert_snapshot!(app = &app; "collaboration_selector_chinese", render(&app));
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
        approval_mode: ApprovalMode::Manual,
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

fn effort_data() -> crate::models::ModelPickerData {
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
                retirement: None,
                description: None,
                discovered: None,
                model: ash_protocol::ModelRef::new(
                    ash_protocol::ProviderId::new("openai").unwrap(),
                    ash_protocol::ModelId::new("test-model").unwrap(),
                ),
                display_name: "Test Model".into(),
                context_window: None,
                maximum_context_window: None,
                default_context_window: None,
                long_context: None,
                selected_acceleration: None,
        acceleration_options: Vec::new(),
                auto_compact_token_limit: None,
                available_context_window: None,
                capabilities: ash_protocol::ModelCapabilities::UNKNOWN,
                settings: Default::default(),
                supported_reasoning_efforts: vec![
                    ash_protocol::ModelReasoningEffortOption {
                        effort: ReasoningEffort::Low,
                        description: Some("Less reasoning for quick, straightforward tasks.".into()),
                    },
                    ash_protocol::ModelReasoningEffortOption {
                        effort: ReasoningEffort::High,
                        description: Some("More reasoning for complex tasks and careful verification.".into()),
                    },
                    ash_protocol::ModelReasoningEffortOption {
                        effort: ReasoningEffort::Max,
                        description: Some("Maximum reasoning. May use more tokens and take longer; use for the hardest tasks.".into()),
                    },
                ],
                default_reasoning_effort: Some(ReasoningEffort::Low),
                default_personality: None,
            },
        ],
    };
    crate::models::ModelPickerData::new(catalog, config)
}

#[test]
fn fullscreen_effort_cancel_preserves_draft_and_mode_across_screen_switches() {
    let data = effort_data();
    let mut app = App::new();
    app.set_collaboration_mode(CollaborationMode::Plan);
    app.update(ThreadEvent::ProductNotice(
        "Conversation remains visible".into(),
    ));
    app.insert_text("keep this draft\nand this line");
    app.open_command_panel(super::command_panel::CommandPanel::Effort(
        data.effort_selector(app.collaboration_mode()).unwrap(),
    ));
    key(&mut app, KeyCode::Right, KeyModifiers::NONE);
    key(&mut app, KeyCode::Tab, KeyModifiers::NONE);
    assert_eq!(app.collaboration_mode(), CollaborationMode::Plan);
    crate::tui_assert_snapshot!(app = &app; "effort_selector_staged", render_effort(&app));
    switch(&mut app, ScreenMode::Inline);
    crate::tui_assert_snapshot!(app = &app; "effort_selector_transferred", render_effort(&app));
    switch(&mut app, ScreenMode::Fullscreen);
    assert_eq!(key(&mut app, KeyCode::Esc, KeyModifiers::NONE), None);
    assert_eq!(app.collaboration_mode(), CollaborationMode::Plan);
    assert_eq!(app.input(), "keep this draft\nand this line");
    assert!(app.chat_input_focused());
    assert!(app.command_panel().is_none());
    crate::tui_assert_snapshot!(app = &app; "effort_selector_cancel_restores_draft", render_effort(&app));
}

#[test]
fn fullscreen_effort_confirm_applies_multitask_and_only_supported_levels() {
    let data = effort_data();
    let mut app = App::new();
    app.open_command_panel(super::command_panel::CommandPanel::Effort(
        data.effort_selector(app.collaboration_mode()).unwrap(),
    ));
    key(&mut app, KeyCode::Right, KeyModifiers::NONE);
    key(&mut app, KeyCode::Right, KeyModifiers::NONE);
    key(&mut app, KeyCode::Tab, KeyModifiers::NONE);
    assert_eq!(app.collaboration_mode(), CollaborationMode::Agent);
    assert_eq!(
        key(&mut app, KeyCode::Enter, KeyModifiers::NONE),
        Some(AppCommand::Models(crate::models::Command::SetEffort {
            effort: ash_protocol::ReasoningEffort::Max
        }))
    );
    assert_eq!(app.collaboration_mode(), CollaborationMode::Multitask);
    assert!(app.command_panel().is_none());
    assert!(app.chat_input_focused());
    crate::tui_assert_snapshot!(app = &app; "effort_selector_confirm_restores_composer", render_effort(&app));
}

#[test]
fn fullscreen_effort_narrow_chinese_keeps_controls_and_draft_isolated() {
    let data = effort_data();
    let mut app = App::new();
    let mut settings = TerminalSettings::default();
    settings.set_language(crate::nls::Language::Chinese);
    app.update(ConfigEvent::SettingsReceived(settings));
    app.insert_text("原来的草稿");
    app.open_command_panel(super::command_panel::CommandPanel::Effort(
        data.effort_selector(app.collaboration_mode()).unwrap(),
    ));
    let area = ratatui::layout::Rect::new(0, 0, 40, 24);
    app.handle_key_in_area(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE), area);
    app.handle_paste("must not reach the draft".into());
    app.handle_key_in_area(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE), area);
    assert_eq!(app.input(), "原来的草稿");
    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(40, 24)).unwrap();
    terminal
        .draw(|frame| super::frame::draw(frame, &app))
        .unwrap();
    let buffer = terminal.backend().buffer();
    let content = crate::terminal::text::text_in_range(
        buffer,
        crate::terminal::text::ScreenSelectionRange::new(
            ratatui::layout::Position::new(0, 0),
            ratatui::layout::Position::new(39, 23),
        ),
    )
    .unwrap();
    assert!(content.contains("推理强度"));
    assert!(content.contains("更快"));
    assert!(content.contains("更聪明"));
    assert!(!content.contains("当前："));
    assert!(!content.contains("由 Ash 协调"));
    assert!(content.contains("Enter 应用"));
    assert!(content.contains("Esc 取消"));
    assert!(!content.contains("原来的草稿"));
    crate::tui_assert_snapshot!(app = &app; "effort_selector_narrow_chinese", content);
    app.handle_key_in_area(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE), area);
    assert_eq!(app.input(), "原来的草稿");
    assert!(app.chat_input_focused());
}

fn render_effort(app: &App) -> String {
    render(app)
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}
