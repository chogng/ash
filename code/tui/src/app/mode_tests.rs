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
    crate::tui_assert_snapshot!("fullscreen_scroll_with_shared_draft", render(&app));

    switch(&mut app, ScreenMode::Inline);
    assert!(app.transcript_scroll().anchor().is_none());
    assert_eq!(app.input(), "shared draft");
    assert_eq!(app.queue_view().items[0].text, "queued message");
    app.handle_key_in_area(KeyEvent::new(KeyCode::Home, KeyModifiers::CONTROL), area);
    let inline_anchor = app.transcript_scroll().anchor().cloned();
    assert!(inline_anchor.is_some());
    assert_ne!(inline_anchor, fullscreen_anchor);
    crate::tui_assert_snapshot!("inline_scroll_with_shared_draft", render(&app));

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
    crate::tui_assert_snapshot!("panel_transferred_to_inline", render(&app));

    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_none());
    assert!(app.chat_input_focused());
    assert_eq!(app.input(), "keep editing this draft");
    crate::tui_assert_snapshot!("inline_draft_after_panel_dismissed", render(&app));
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
        crate::tui_assert_snapshot!(snapshot, render(&app));

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
        crate::tui_assert_snapshot!(snapshot, render(&app));

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
            Position::new(
                input.x
                    + match target {
                        ScreenMode::Fullscreen => 7,
                        ScreenMode::Inline => 3,
                    },
                input.y + 1
            )
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
            session_id: ash_protocol::SessionId::new(name).unwrap(),
            title: format!("{name} session"),
            status: ash_protocol::SessionStatus::Active,
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
    crate::tui_assert_snapshot!("fullscreen_home_after_inline_navigation", render(&app));
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
    crate::tui_assert_snapshot!("inline_manager_own_selection", render(&app));
    switch(&mut app, ScreenMode::Fullscreen);
    assert_eq!(
        app.session_navigation().manager().selected_session(),
        selected.as_ref()
    );
    assert!(app.session_manager_focused());
    assert_eq!(app.sessions.catalog().len(), 2);
    assert_eq!(app.sessions.active_session_id().unwrap().as_str(), "first");
    crate::tui_assert_snapshot!("fullscreen_manager_own_selection", render(&app));
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
    crate::tui_assert_snapshot!("inline_preview_ignores_other_mode_reply", render(&app));
    switch(&mut app, ScreenMode::Fullscreen);
    assert_eq!(
        app.session_preview().unwrap().notice(),
        Some("fullscreen preview failed")
    );
    crate::tui_assert_snapshot!("fullscreen_preview_receives_own_reply", render(&app));
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
    crate::tui_assert_snapshot!("fullscreen_issues_receive_own_result", render(&app));
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
    crate::tui_assert_snapshot!("clipboard_result_belongs_to_new_task_draft", render(&app));
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
        "fullscreen_detail_is_not_replaced_by_inline_detail",
        render(&app)
    );
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.overlay().is_none());
    switch(&mut app, ScreenMode::Inline);
    assert_eq!(app.overlay().unwrap().title(), "Inline detail");
}
