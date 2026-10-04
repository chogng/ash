use super::App;
use super::AppEvent;
use crate::config::Event as ConfigEvent;
use crate::config::TerminalSettings;
use crate::terminal::ScreenMode;
use crate::thread::Event as ThreadEvent;
use crate::thread::composer::ChatInputQueueOutcome;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionModel;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::layout::Position;
use ratatui::layout::Rect;

fn switch(app: &mut App, mode: ScreenMode) {
    let mut settings = TerminalSettings::default();
    settings.set_screen_mode(mode);
    app.update(ConfigEvent::SettingsReceived(settings));
}

fn render(app: &App) -> String {
    let mut terminal = Terminal::new(TestBackend::new(50, 16)).unwrap();
    terminal
        .draw(|frame| super::frame::draw(frame, app))
        .unwrap();
    terminal
        .backend()
        .buffer()
        .content
        .chunks(50)
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn command_result_preserves_the_marker_column_in_both_modes() {
    for mode in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        for (result, continuation, snapshot) in [
            (
                "first result\nsecond result".to_owned(),
                "s",
                "command_result_detail_indent",
            ),
            ("x".repeat(80), "x", "wrapped_command_result_detail_indent"),
        ] {
            let first_character = result.chars().next().unwrap().to_string();
            let mut app = App::new();
            switch(&mut app, mode);
            app.update(ThreadEvent::CommandCompleted {
                command: "/command".into(),
                result,
            });
            let area = Rect::new(0, 0, 50, 16);
            app.handle_key_in_area(KeyEvent::new(KeyCode::Home, KeyModifiers::CONTROL), area);
            assert!(app.transcript_scroll().anchor().is_some());
            let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
            terminal
                .draw(|frame| super::frame::draw(frame, &app))
                .unwrap();
            let buffer = terminal.backend().buffer();
            let command_row = (0..area.height)
                .find(|&y| {
                    (0..area.width)
                        .map(|x| buffer[(x, y)].symbol())
                        .collect::<String>()
                        .contains("> /command")
                })
                .expect("the command is visible");
            let marker_column = (0..area.width)
                .find(|&x| buffer[(x, command_row)].symbol() == ">")
                .unwrap();
            assert_eq!(buffer[(marker_column, command_row + 1)].symbol(), " ");
            assert_eq!(buffer[(marker_column + 1, command_row + 1)].symbol(), "└");
            assert_eq!(
                buffer[(marker_column + 4, command_row + 1)].symbol(),
                first_character
            );
            assert_eq!(
                buffer[(marker_column + 4, command_row + 2)].symbol(),
                continuation
            );
            for column in marker_column..marker_column + 4 {
                assert_eq!(buffer[(column, command_row + 2)].symbol(), " ");
            }
            assert_eq!(
                buffer[(marker_column + 1, command_row + 1)].fg,
                app.render_context().muted()
            );
            crate::tui_assert_snapshot!(app = &app; snapshot, render(&app));
        }
    }
}

#[test]
fn modes_restore_their_own_scroll_while_sharing_the_draft_and_queue() {
    let mut app = App::new();
    for index in 0..16 {
        app.update(ThreadEvent::FailureReported(format!("message {index:02}")));
    }
    app.insert_text("queued message");
    let ChatInputQueueOutcome::Queued(queued) =
        app.thread_presentations.active_mut().input.queue_current()
    else {
        panic!("the draft must become a queue entry");
    };
    app.thread_presentations.active_mut().queue.push(queued);
    app.insert_text("shared draft");
    let area = Rect::new(0, 0, 50, 16);
    app.handle_key_in_area(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE), area);
    let fullscreen_anchor = app.transcript_scroll().anchor().cloned();
    assert!(fullscreen_anchor.is_some());
    crate::tui_assert_snapshot!(app = &app; "fullscreen_scroll_with_shared_draft", render(&app));

    switch(&mut app, ScreenMode::Inline);
    assert!(app.transcript_scroll().anchor().is_none());
    assert_eq!(app.input(), "shared draft");
    assert_eq!(app.queue_view().items[0].text, "queued message");
    app.handle_key_in_area(KeyEvent::new(KeyCode::Home, KeyModifiers::CONTROL), area);
    let inline_anchor = app.transcript_scroll().anchor().cloned();
    assert!(inline_anchor.is_some());
    assert_ne!(inline_anchor, fullscreen_anchor);
    crate::tui_assert_snapshot!(app = &app; "inline_scroll_with_shared_draft", render(&app));

    switch(&mut app, ScreenMode::Fullscreen);
    assert_eq!(app.transcript_scroll().anchor(), fullscreen_anchor.as_ref());
    switch(&mut app, ScreenMode::Inline);
    assert_eq!(app.transcript_scroll().anchor(), inline_anchor.as_ref());
    assert_eq!(app.input(), "shared draft");
    assert_eq!(app.queue_view().items[0].text, "queued message");
}

#[test]
fn switching_modes_moves_the_active_panel_and_keeps_its_keyboard_selection() {
    let mut app = App::new();
    app.insert_text("keep editing this draft");
    app.update(AppEvent::HelpOpened(ListSelectionModel::new(
        "Help",
        vec![ListSelectionGroup::new(
            "Commands",
            vec![
                ListSelectionItem::new("First"),
                ListSelectionItem::new("Second"),
            ],
        )],
    )));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert_eq!(
        app.list_selection().unwrap().selected_visible_index(),
        Some(1)
    );

    switch(&mut app, ScreenMode::Inline);
    assert!(app.fullscreen.panels.command().is_none());
    assert!(app.inline.panels.command().is_some());
    assert_eq!(
        app.list_selection().unwrap().selected_visible_index(),
        Some(1)
    );
    assert!(!app.chat_input_focused());
    crate::tui_assert_snapshot!(app = &app; "panel_transferred_to_inline", render(&app));

    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_none());
    assert!(app.chat_input_focused());
    assert_eq!(app.input(), "keep editing this draft");
    crate::tui_assert_snapshot!(app = &app; "inline_draft_after_panel_dismissed", render(&app));
    switch(&mut app, ScreenMode::Fullscreen);
    assert!(app.command_panel().is_none());
    assert_eq!(app.input(), "keep editing this draft");
}

#[test]
fn clearing_the_conversation_removes_selection_from_the_inactive_mode() {
    let mut app = App::new();
    app.update(ThreadEvent::ContextChanged {
        session_id: ash_protocol::SessionId::new("session").unwrap(),
        thread_id: ash_protocol::ThreadId::new("thread").unwrap(),
    });
    app.update(ThreadEvent::FailureReported("message to clear".into()));
    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::CONTROL));
    assert!(app.transcript_selection_active());
    switch(&mut app, ScreenMode::Inline);
    assert!(!app.transcript_selection_active());
    app.update(ThreadEvent::TranscriptCleared);
    switch(&mut app, ScreenMode::Fullscreen);
    assert!(!app.transcript_selection_active());
    assert!(app.transcript_scroll().anchor().is_none());
    assert!(app.chat_input_focused());
}

fn focus_app() -> App {
    let mut app = App::new();
    app.update(ThreadEvent::ContextChanged {
        session_id: ash_protocol::SessionId::new("focus-session").unwrap(),
        thread_id: ash_protocol::ThreadId::new("focus-thread").unwrap(),
    });
    for index in 0..8 {
        app.update(ThreadEvent::FailureReported(format!(
            "focus message {index:02}"
        )));
    }
    app
}

#[test]
fn modes_restore_independent_queue_and_transcript_focus() {
    for (target, other, snapshot) in [
        (
            ScreenMode::Fullscreen,
            ScreenMode::Inline,
            "restored_fullscreen_transcript_focus",
        ),
        (
            ScreenMode::Inline,
            ScreenMode::Fullscreen,
            "restored_inline_transcript_focus",
        ),
    ] {
        let mut app = focus_app();
        app.insert_text("queued message");
        let ChatInputQueueOutcome::Queued(queued) =
            app.thread_presentations.active_mut().input.queue_current()
        else {
            panic!("queued input expected");
        };
        app.thread_presentations.active_mut().queue.push(queued);
        switch(&mut app, target);
        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::CONTROL));
        assert!(app.transcript_selection_active());

        switch(&mut app, other);
        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::ALT));
        assert!(app.queue_focused());
        // Reloading the same setting must not end an ongoing interaction.
        switch(&mut app, other);
        assert!(app.queue_focused());

        switch(&mut app, target);
        assert!(!app.queue_focused());
        assert!(app.transcript_selection_active());
        assert_eq!(app.queue_view().items[0].text, "queued message");
        crate::tui_assert_snapshot!(app = &app; snapshot, render(&app));

        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(!app.transcript_selection_active());
        assert!(app.chat_input_focused());
        switch(&mut app, other);
        assert!(app.queue_focused());
    }
}

#[test]
fn escape_returns_to_the_shared_draft_after_restoring_transcript_selection() {
    for (target, other, snapshot) in [
        (
            ScreenMode::Fullscreen,
            ScreenMode::Inline,
            "fullscreen_draft_after_selection_escape",
        ),
        (
            ScreenMode::Inline,
            ScreenMode::Fullscreen,
            "inline_draft_after_selection_escape",
        ),
    ] {
        let mut app = focus_app();
        switch(&mut app, target);
        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::CONTROL));
        assert!(app.transcript_selection_active());
        switch(&mut app, other);
        app.handle_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE));
        assert_eq!(app.input(), "x");
        assert!(app.chat_input_focused());

        switch(&mut app, target);
        assert!(app.transcript_selection_active());
        for kind in [KeyEventKind::Release, KeyEventKind::Repeat] {
            app.handle_key(KeyEvent::new_with_kind(
                KeyCode::Esc,
                KeyModifiers::NONE,
                kind,
            ));
            assert!(app.transcript_selection_active());
        }
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(app.input(), "x");
        assert!(!app.transcript_selection_active());
        assert!(app.chat_input_focused());
        crate::tui_assert_snapshot!(app = &app; snapshot, render(&app));

        let area = Rect::new(0, 0, 50, 16);
        let input = match target {
            ScreenMode::Fullscreen => super::fullscreen::layout(&app, area).input,
            ScreenMode::Inline => super::inline::layout(&app, area).input,
        };
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal
            .draw(|frame| super::frame::draw(frame, &app))
            .unwrap();
        assert_eq!(
            terminal.get_cursor_position().unwrap(),
            Position::new(input.x + 3, input.y + 1)
        );
    }
}

#[test]
fn manager_navigation_in_one_mode_preserves_the_other_transcript_focus() {
    for (target, other) in [
        (ScreenMode::Fullscreen, ScreenMode::Inline),
        (ScreenMode::Inline, ScreenMode::Fullscreen),
    ] {
        let mut app = focus_app();
        switch(&mut app, target);
        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::CONTROL));
        assert!(app.transcript_selection_active());
        switch(&mut app, other);
        app.handle_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        assert!(app.session_manager_focused());
        switch(&mut app, target);
        assert!(app.session_manager_view().is_none());
        assert!(!app.session_manager_focused());
        assert!(app.transcript_selection_active());
        switch(&mut app, other);
        assert!(app.session_manager_focused());
    }
}

fn session_catalog() -> Vec<ash_protocol::Session> {
    ["first", "second"]
        .into_iter()
        .map(|name| ash_protocol::Session {
            model: None,
            session_id: ash_protocol::SessionId::new(name).unwrap(),
            title: format!("{name} session"),
            status: ash_protocol::SessionStatus::Active,
            execution_target: None,
            manager: Default::default(),
            threads: vec![ash_protocol::SessionThread {
                thread_id: ash_protocol::ThreadId::new(name).unwrap(),
                title: "main".into(),
                created_at_unix_ms: 1,
                completed_turn_duration_ms: 0,
                active_turn_started_at_unix_ms: None,
                usage: Default::default(),
                parent_thread_id: None,
                forked_from_id: None,
                status: ash_protocol::ThreadStatus::Active,
            }],
        })
        .collect()
}

fn navigation_app() -> App {
    let mut app = App::new();
    app.update(ThreadEvent::ContextChanged {
        session_id: ash_protocol::SessionId::new("first").unwrap(),
        thread_id: ash_protocol::ThreadId::new("first").unwrap(),
    });
    app.update(crate::sessions::Event::CatalogReceived(session_catalog()));
    app
}

#[test]
fn inline_navigation_does_not_replace_the_fullscreen_home() {
    let mut app = navigation_app();
    app.open_home();
    switch(&mut app, ScreenMode::Inline);
    app.insert_text("/dashboard");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    assert!(app.session_manager_focused());
    app.update(ThreadEvent::ContextChanged {
        session_id: ash_protocol::SessionId::new("second").unwrap(),
        thread_id: ash_protocol::ThreadId::new("second").unwrap(),
    });
    assert!(app.session_manager_focused());
    assert_eq!(app.sessions.active_session_id().unwrap().as_str(), "second");
    switch(&mut app, ScreenMode::Fullscreen);
    assert!(app.fullscreen_home_visible());
    assert!(app.session_manager_view().is_none());
    crate::tui_assert_snapshot!(app = &app; "fullscreen_home_after_inline_navigation", render(&app));
    switch(&mut app, ScreenMode::Inline);
    assert!(app.session_manager_focused());
    assert!(app.session_manager_view().is_some());
}

#[test]
fn managers_share_the_catalogue_but_keep_separate_selections_and_focus() {
    let mut app = navigation_app();
    app.handle_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    let selected = app
        .session_navigation()
        .manager()
        .selected_session()
        .cloned();
    assert_eq!(selected.as_ref().map(|id| id.as_str()), Some("second"));
    switch(&mut app, ScreenMode::Inline);
    assert!(app.session_manager_view().is_none());
    assert!(app.chat_input_focused());
    app.handle_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    assert_eq!(
        app.session_navigation()
            .manager()
            .selected_session()
            .map(|id| id.as_str()),
        Some("first")
    );
    crate::tui_assert_snapshot!(app = &app; "inline_manager_own_selection", render(&app));
    switch(&mut app, ScreenMode::Fullscreen);
    assert_eq!(
        app.session_navigation().manager().selected_session(),
        selected.as_ref()
    );
    assert!(app.session_manager_focused());
    assert_eq!(app.sessions.catalog().len(), 2);
    assert_eq!(app.sessions.active_session_id().unwrap().as_str(), "first");
    crate::tui_assert_snapshot!(app = &app; "fullscreen_manager_own_selection", render(&app));
}

#[test]
fn transferred_panel_takes_input_above_the_inline_preview() {
    let mut app = navigation_app();
    switch(&mut app, ScreenMode::Inline);
    app.handle_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    assert!(matches!(
        app.handle_key(KeyEvent::new(KeyCode::Char(' '), KeyModifiers::NONE)),
        Some(super::AppCommand::Sessions(
            crate::sessions::Command::Preview { .. }
        ))
    ));
    assert!(app.session_preview().is_some());
    switch(&mut app, ScreenMode::Fullscreen);
    app.update(AppEvent::HelpOpened(ListSelectionModel::new(
        "Help",
        vec![ListSelectionGroup::new(
            "Commands",
            vec![
                ListSelectionItem::new("First"),
                ListSelectionItem::new("Second"),
            ],
        )],
    )));
    crate::tui_assert_snapshot!(app = &app; "fullscreen_panel_before_preview_handoff", render(&app));
    switch(&mut app, ScreenMode::Inline);
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert_eq!(
        app.list_selection().unwrap().selected_visible_index(),
        Some(1)
    );
    assert!(app.session_preview().is_some());
    crate::tui_assert_snapshot!(app = &app; "inline_panel_above_parked_preview", render(&app));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_none());
    assert!(app.session_preview().is_some());
    crate::tui_assert_snapshot!(app = &app; "inline_preview_restored_after_panel", render(&app));
}

#[test]
fn preview_replies_with_equal_generations_stay_with_the_requesting_mode() {
    let mut app = navigation_app();
    let preview = |app: &mut App| {
        app.handle_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        let Some(super::AppCommand::Sessions(crate::sessions::Command::Preview {
            generation, ..
        })) = app.handle_key(KeyEvent::new(KeyCode::Char(' '), KeyModifiers::NONE))
        else {
            panic!("preview request expected");
        };
        generation
    };
    let full_generation = preview(&mut app);
    switch(&mut app, ScreenMode::Inline);
    assert!(app.session_preview().is_none());
    let inline_generation = preview(&mut app);
    assert_eq!(full_generation, inline_generation);
    app.finish_session_preview(
        ScreenMode::Fullscreen,
        full_generation,
        Err("fullscreen preview failed".into()),
    );
    assert_eq!(
        app.session_preview().unwrap().notice(),
        Some("Loading conversation…")
    );
    crate::tui_assert_snapshot!(app = &app; "inline_preview_ignores_other_mode_reply", render(&app));
    switch(&mut app, ScreenMode::Fullscreen);
    assert_eq!(
        app.session_preview().unwrap().notice(),
        Some("fullscreen preview failed")
    );
    crate::tui_assert_snapshot!(app = &app; "fullscreen_preview_receives_own_reply", render(&app));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    switch(&mut app, ScreenMode::Inline);
    assert!(app.session_preview().is_some());
}

#[test]
fn new_task_and_current_conversation_keep_distinct_shared_drafts() {
    let mut app = navigation_app();
    app.insert_text("current conversation draft");
    app.open_home();
    assert_eq!(app.input(), "");
    app.insert_text("new task draft");
    switch(&mut app, ScreenMode::Inline);
    assert!(!app.starts_new_session());
    assert_eq!(app.input(), "current conversation draft");
    app.insert_text(" edited inline");
    switch(&mut app, ScreenMode::Fullscreen);
    assert!(app.fullscreen_home_visible());
    assert_eq!(app.input(), "new task draft");
    crate::tui_assert_snapshot!(
        app = &app;
        "home_draft_is_separate_from_current_conversation",
        render(&app)
    );
    switch(&mut app, ScreenMode::Inline);
    app.open_home();
    assert!(app.starts_new_session());
    assert_eq!(app.input(), "new task draft");
    app.show_conversation();
    assert_eq!(app.input(), "current conversation draft edited inline");
}

#[test]
fn issue_pages_and_their_async_results_are_owned_by_the_requesting_mode() {
    let mut app = navigation_app();
    let open = |app: &mut App| {
        let Some(super::AppCommand::Issues(crate::issues::Command::List { generation, .. })) =
            app.handle_key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE))
        else {
            panic!("issue list request expected");
        };
        (generation, super::requests::RequestOrigin::current(app))
    };
    let (full_generation, origin) = open(&mut app);
    switch(&mut app, ScreenMode::Inline);
    assert!(app.issue_manager().is_none());
    let (inline_generation, _) = open(&mut app);
    assert_eq!(inline_generation, full_generation);
    app.update_from_origin(
        origin,
        crate::issues::Event::Listed {
            generation: full_generation,
            page: 1,
            result: Err("FULL-ISSUE-ERROR".into()),
        },
    );
    assert!(!render(&app).contains("FULL-ISSUE-ERROR"));
    assert!(app.issue_manager().is_some());
    switch(&mut app, ScreenMode::Fullscreen);
    assert!(render(&app).contains("FULL-ISSUE-ERROR"));
    crate::tui_assert_snapshot!(app = &app; "fullscreen_issues_receive_own_result", render(&app));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.issue_manager().is_none());
    switch(&mut app, ScreenMode::Inline);
    assert!(app.issue_manager().is_some());
}

#[test]
fn an_async_clipboard_read_stays_with_its_logical_draft_after_switching_modes() {
    let mut app = navigation_app();
    app.insert_text("current draft");
    app.open_home();
    app.insert_text("new task ");
    let Some(super::AppCommand::Host(crate::host::Command::ReadClipboardImage { target })) =
        app.handle_key(KeyEvent::new(KeyCode::Char('v'), KeyModifiers::CONTROL))
    else {
        panic!("clipboard read expected");
    };
    let image = || crate::host::clipboard::ClipboardImage {
        png: b"\x89PNG\r\n\x1a\npayload".to_vec(),
        fingerprint: crate::host::clipboard::ClipboardImageFingerprint(71),
        width: 1,
        height: 1,
    };
    switch(&mut app, ScreenMode::Inline);
    app.update(crate::host::Event::ClipboardImageRead {
        target: target.clone(),
        result: Ok(image()),
    });
    assert_eq!(app.input(), "current draft");
    switch(&mut app, ScreenMode::Fullscreen);
    assert_eq!(app.input(), "new task [Image #1] ");
    crate::tui_assert_snapshot!(app = &app; "clipboard_result_belongs_to_new_task_draft", render(&app));
    assert!(matches!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(super::AppCommand::Sessions(
            crate::sessions::Command::CreateAndEnter { .. }
        ))
    ));
    app.update(crate::host::Event::ClipboardImageRead {
        target,
        result: Ok(image()),
    });
    assert_eq!(app.input(), "");
    app.fail_session_creation("test failure".into());
    assert_eq!(app.input(), "new task [Image #1] ");
}

#[test]
fn read_only_overlays_stay_in_their_own_modes_instead_of_following_editor_handoff() {
    use crate::widgets::detail_list::DetailList;
    use crate::widgets::detail_list::DetailListRow;
    let mut app = navigation_app();
    app.show_overlay(DetailList::new(
        "Fullscreen detail",
        vec![DetailListRow::new("Text", "full detail")],
    ));
    switch(&mut app, ScreenMode::Inline);
    assert!(app.overlay().is_none());
    app.show_overlay(DetailList::new(
        "Inline detail",
        vec![DetailListRow::new("Text", "inline detail")],
    ));
    switch(&mut app, ScreenMode::Fullscreen);
    assert_eq!(app.overlay().unwrap().title(), "Fullscreen detail");
    crate::tui_assert_snapshot!(
        app = &app;
        "fullscreen_detail_is_not_replaced_by_inline_detail",
        render(&app)
    );
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.overlay().is_none());
    switch(&mut app, ScreenMode::Inline);
    assert_eq!(app.overlay().unwrap().title(), "Inline detail");
}

#[test]
fn model_options_work_in_both_modes_and_keep_the_draft_after_dismissal() {
    use super::AppCommand;
    use crate::models::Command as ModelCommand;
    use crate::models::Event as ModelEvent;
    use crate::models::ModelOption;
    let model = ash_protocol::ModelRef::new(
        ash_protocol::ProviderId::new("openai").unwrap(),
        ash_protocol::ModelId::new("gpt-6-astra").unwrap(),
    );
    let mut info = ash_protocol::ModelInfo::new(model.model.clone(), "GPT-6 Astra");
    info.context_window = ash_protocol::ContextWindow::Known(1_050_000);
    info.capabilities.fast_mode = ash_protocol::CapabilitySupport::Supported;
    info.supported_reasoning_efforts = vec![
        ash_protocol::ReasoningEffort::Low,
        ash_protocol::ReasoningEffort::Medium,
        ash_protocol::ReasoningEffort::High,
    ];
    info.model_reasoning_effort = Some(ash_protocol::ReasoningEffort::Medium);
    let catalog = ash_app_server_protocol::protocol::model::ModelListResult {
        models: vec![{
            let mut entry = ash_app_server_protocol::protocol::model::ModelCatalogEntry::from_info(
                model, &info,
            );
            entry.context_window = Some(272_000);
            entry
        }],
    };
    for mode in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        let mut app = App::new();
        switch(&mut app, mode);
        app.insert_text("preserved draft");
        let mut config = crate::test_support::empty_config_snapshot();
        config.revision = 8;
        app.update(ModelEvent::PickerOpened(
            crate::models::model_choices(&catalog, &config).unwrap(),
        ));
        for option in [ModelOption::FastOn, ModelOption::Context1m] {
            assert_eq!(
                app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)),
                None
            );
            assert_eq!(
                app.handle_key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE)),
                Some(AppCommand::Models(ModelCommand::Configure {
                    preference: "openai/gpt-6-astra".into(),
                    revision: 8,
                    option
                }))
            );
            assert!(app.command_panel().is_some());
        }
        let mut terminal = Terminal::new(TestBackend::new(120, 20)).unwrap();
        terminal
            .draw(|frame| super::frame::draw(frame, &app))
            .unwrap();
        let output = terminal.backend().to_string();
        assert!(output.contains("[Fast off]"));
        assert!(output.contains("[272k]"));
        crate::tui_assert_snapshot!(app = &app; format!("model_options_{mode:?}"), output);
        for modifiers in [KeyModifiers::NONE, KeyModifiers::SHIFT] {
            app.handle_key(KeyEvent::new(KeyCode::Char('/'), modifiers));
            assert!(
                app.list_selection()
                    .unwrap()
                    .search()
                    .unwrap()
                    .input_active()
            );
            assert_eq!(app.list_selection().unwrap().query(), "");
            terminal
                .draw(|frame| super::frame::draw(frame, &app))
                .unwrap();
            let cursor = terminal.get_cursor_position().unwrap();
            let buffer = terminal.backend().buffer();
            assert_eq!(
                buffer[(cursor.x, cursor.y - 1)].fg,
                app.render_context().focus()
            );
            assert_eq!(buffer[(cursor.x, cursor.y)].symbol(), "S");
            app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
            assert!(
                !app.list_selection()
                    .unwrap()
                    .search()
                    .unwrap()
                    .input_active()
            );
            assert!(app.command_panel().is_some());
        }
        app.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));
        for character in "astra".chars() {
            app.handle_key(KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE));
        }
        assert_eq!(app.list_selection().unwrap().query(), "astra");
        assert_eq!(app.list_selection().unwrap().visible_items().len(), 1);
        terminal
            .draw(|frame| super::frame::draw(frame, &app))
            .unwrap();
        crate::tui_assert_snapshot!(
            app = &app;
            format!("model_search_{mode:?}"),
            terminal.backend().to_string()
        );
        app.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::SHIFT));
        assert_eq!(app.list_selection().unwrap().query(), "astra/");
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(app.command_panel().is_some());
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(app.command_panel().is_none());
        assert_eq!(app.input(), "preserved draft");
    }
}

#[test]
fn cached_error_updates_language_while_joined_emoji_remains_one_input_glyph_in_both_modes() {
    for mode in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        let mut app = App::new();
        switch(&mut app, mode);
        app.update(ThreadEvent::FailureReported("Error".into()));
        app.insert_text("x👩‍💻z");
        app.handle_key_in_area(
            KeyEvent::new(KeyCode::Home, KeyModifiers::CONTROL),
            Rect::new(0, 0, 10, 16),
        );
        let mut terminal = Terminal::new(TestBackend::new(10, 16)).unwrap();
        terminal
            .draw(|frame| super::frame::draw(frame, &app))
            .unwrap();
        let mut settings = TerminalSettings::default();
        settings.set_screen_mode(mode);
        settings.set_language(crate::nls::Language::Chinese);
        app.update(ConfigEvent::SettingsReceived(settings));
        terminal
            .draw(|frame| super::frame::draw(frame, &app))
            .unwrap();
        let buffer = terminal.backend().buffer();
        assert!(buffer.content.iter().any(|cell| cell.symbol() == "👩‍💻"));
        assert!(buffer.content.iter().any(|cell| cell.symbol() == "错"));
        let output = crate::terminal::text::text_in_range(
            buffer,
            crate::terminal::text::ScreenSelectionRange::new(
                Position::new(0, 0),
                Position::new(9, 15),
            ),
        )
        .unwrap();
        crate::tui_assert_snapshot!(app = &app; "unicode_input_after_language_change", output);
    }
}
