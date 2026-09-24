use super::activate_pointer_item;
use super::handle_mouse;
use super::update_pointer_hover;
use crate::app::App;
use crate::app::AppCommand;
use crate::app::AppEvent;
use crate::app::frame;
use crate::app::fullscreen::pointer::PointerTarget;
use crate::sessions::Command as SessionCommand;
use crate::sessions::Event as SessionEvent;
use crate::terminal::MouseMode;
use crate::thread::Command as ThreadCommand;
use crate::thread::Event as ThreadEvent;
use crate::thread::composer::ChatComposerPointerTarget;
use crate::thread::composer::CompletionView;
use crate::thread::transcript::ChatHistoryPointerTarget;
use crate::thread::transcript::TranscriptScrollDirection;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::search_box::SearchBoxModel;
use ash_protocol::Session;
use ash_protocol::SessionId;
use ash_protocol::SessionManagerInfo;
use ash_protocol::SessionStatus;
use ash_protocol::SessionThread;
use ash_protocol::ThreadId;
use ash_protocol::ThreadStatus;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use crossterm::event::MouseButton;
use crossterm::event::MouseEvent;
use crossterm::event::MouseEventKind;
use ratatui::layout::Rect;

#[test]
fn clearing_fullscreen_cancels_the_drag_before_a_fresh_click_at_the_new_size() {
    let mut app = App::new();
    app.insert_text("/q");
    let old_area = Rect::new(0, 0, 80, 24);
    let old_row = crate::app::fullscreen::layout(&app, old_area).input.y - 1;
    let event = |kind, column, row| MouseEvent {
        kind,
        column,
        row,
        modifiers: KeyModifiers::NONE,
    };
    handle_mouse(&mut app, old_area, event(MouseEventKind::Moved, 2, old_row));
    handle_mouse(
        &mut app,
        old_area,
        event(MouseEventKind::Down(MouseButton::Left), 2, old_row),
    );
    assert!(app.fullscreen.pointer.pressed().is_some());
    handle_mouse(
        &mut app,
        old_area,
        event(MouseEventKind::Drag(MouseButton::Left), 8, old_row),
    );
    assert!(app.fullscreen.selection.range().is_some());

    // The terminal Resize event invalidates all full-screen interaction state.
    app.fullscreen.clear();
    let area = Rect::new(0, 0, 40, 12);
    assert!(matches!(
        handle_mouse(
            &mut app,
            area,
            event(MouseEventKind::Up(MouseButton::Left), 8, old_row),
        ),
        super::MouseAction::Selection(None)
    ));
    assert!(app.fullscreen.selection.range().is_none());
    assert!(app.fullscreen.pointer.hovered().is_none());
    assert!(app.fullscreen.pointer.pressed().is_none());
    assert_eq!(app.input(), "/q");

    let mut terminal =
        ratatui::Terminal::new(ratatui::backend::TestBackend::new(area.width, area.height))
            .unwrap();
    terminal.draw(|frame| frame::draw(frame, &app)).unwrap();
    let buffer = terminal.backend().buffer();
    assert!(
        buffer
            .content
            .iter()
            .all(|cell| { cell.bg != app.render_context().screen_selection_background() })
    );
    let text = buffer
        .content
        .chunks(usize::from(area.width))
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n");
    crate::tui_assert_snapshot!("resized_completion_after_cancelled_selection", text);

    let row = crate::app::fullscreen::layout(&app, area).input.y - 1;
    assert_ne!(row, old_row);
    assert_eq!(
        super::target_at(&app, area, 2, row),
        Some(PointerTarget::Composer(
            ChatComposerPointerTarget::CompletionItem(0)
        ))
    );
    handle_mouse(
        &mut app,
        area,
        event(MouseEventKind::Down(MouseButton::Left), 2, row),
    );
    let super::MouseAction::Selection(Some(
        super::super::selection::ScreenSelectionOutcome::Click { position, count },
    )) = handle_mouse(
        &mut app,
        area,
        event(MouseEventKind::Up(MouseButton::Left), 2, row),
    )
    else {
        panic!("a fresh press and release must produce a click");
    };
    assert_eq!(count, super::super::selection::ClickCount::Single);
    assert_eq!(
        activate_pointer_item(&mut app, area, position.x, position.y),
        Some(AppCommand::Quit)
    );
}

#[test]
fn fullscreen_selection_copies_text_and_reports_the_clipboard_result() {
    for (name, result) in [
        ("fullscreen_selection_copied", Ok(())),
        (
            "fullscreen_selection_copy_failed",
            Err("clipboard unavailable".to_owned()),
        ),
    ] {
        let mut app = App::new();
        app.insert_text("copy me");
        let area = Rect::new(0, 0, 60, 16);
        let row = crate::app::fullscreen::layout(&app, area).input.y + 1;
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(area.width, area.height))
                .unwrap();
        terminal
            .draw(|frame| crate::app::frame::draw(frame, &app))
            .unwrap();
        let mouse = |kind, column| MouseEvent {
            kind,
            column,
            row,
            modifiers: KeyModifiers::NONE,
        };
        handle_mouse(
            &mut app,
            area,
            mouse(MouseEventKind::Down(MouseButton::Left), 6),
        );
        handle_mouse(
            &mut app,
            area,
            mouse(MouseEventKind::Drag(MouseButton::Left), 12),
        );
        let super::MouseAction::Selection(Some(
            crate::app::fullscreen::selection::ScreenSelectionOutcome::Selection(range),
        )) = handle_mouse(
            &mut app,
            area,
            mouse(MouseEventKind::Up(MouseButton::Left), 12),
        )
        else {
            panic!("drag must select text");
        };
        let mut copied = None;
        super::super::selection::apply_screen_selection(
            &mut app,
            range,
            |range| crate::terminal::text::text_in_range(terminal.backend().buffer(), range),
            |text| {
                copied = Some(text.to_owned());
                result.clone()
            },
        );
        assert_eq!(copied.as_deref(), Some("copy me"));
        assert_eq!(app.fullscreen.selection.range(), Some(range));
        terminal
            .draw(|frame| crate::app::frame::draw(frame, &app))
            .unwrap();
        let buffer = terminal.backend().buffer();
        assert_eq!(
            buffer[(6, row)].bg,
            app.render_context().screen_selection_background()
        );
        let text = buffer
            .content
            .chunks(usize::from(area.width))
            .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n");
        if result.is_ok() {
            assert!(text.contains("Copied 7 chars to clipboard"));
        } else {
            assert!(text.contains("clipboard unavailable"));
        }
        crate::tui_assert_snapshot!(name, text);
    }
}

#[test]
fn input_focus_follows_clicks_and_clicking_modal_backdrop_closes_modal() {
    let mut app = App::new();
    app.insert_text("draft");
    let area = Rect::new(0, 0, 80, 24);
    let areas = crate::app::fullscreen::layout(&app, area);
    let input_position = ratatui::layout::Position::new(
        crate::thread::composer::content_area(areas.input).x,
        areas.input.y,
    );
    let page_position =
        ratatui::layout::Position::new(areas.session.transcript.x, areas.session.transcript.y);
    let mouse = |kind, position: ratatui::layout::Position| MouseEvent {
        kind,
        column: position.x,
        row: position.y,
        modifiers: KeyModifiers::NONE,
    };
    let input_border = |app: &App| {
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(area.width, area.height))
                .unwrap();
        terminal.draw(|frame| frame::draw(frame, app)).unwrap();
        terminal.backend().buffer()[input_position].fg
    };

    assert_eq!(
        super::target_at(&app, area, input_position.x, input_position.y),
        Some(PointerTarget::Composer(ChatComposerPointerTarget::Input))
    );
    assert!(app.chat_input_focused());
    assert_eq!(input_border(&app), app.render_context().chat_input_chrome());

    handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Down(MouseButton::Left), page_position),
    );
    handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Up(MouseButton::Left), page_position),
    );
    assert!(!app.chat_input_focused());
    assert_eq!(input_border(&app), app.render_context().border());
    app.handle_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE));
    app.handle_paste("ignored".into());
    assert_eq!(app.input(), "draft");

    handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Down(MouseButton::Left), input_position),
    );
    handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Up(MouseButton::Left), input_position),
    );
    assert!(app.chat_input_focused());
    assert_eq!(input_border(&app), app.render_context().chat_input_chrome());

    app.update(AppEvent::HelpOpened(ListSelectionModel::new(
        "Help",
        vec![ListSelectionGroup::new(
            "Commands",
            vec![ListSelectionItem::new("Help")],
        )],
    )));
    assert!(!app.chat_input_focused());
    let modal = super::super::modal::layout(area).surface;
    let outside = ratatui::layout::Position::new(area.x, area.y);
    assert!(!modal.contains(outside));
    handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Down(MouseButton::Left), outside),
    );
    handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Up(MouseButton::Left), outside),
    );
    assert!(app.command_panel().is_none());
    assert!(app.chat_input_focused());
}

#[test]
fn command_modals_capture_mouse_and_keep_keyboard_navigation() {
    let mut app = App::new();
    app.update(AppEvent::HelpOpened(
        ListSelectionModel::new(
            "Items",
            vec![
                ListSelectionGroup::new(
                    "First",
                    (0..40)
                        .map(|index| ListSelectionItem::new(format!("Item {index}")))
                        .collect(),
                ),
                ListSelectionGroup::new("Second", vec![ListSelectionItem::new("Other")]),
            ],
        )
        .with_search(SearchBoxModel::new("Search")),
    ));
    for area in [Rect::new(0, 0, 80, 24), Rect::new(0, 0, 12, 3)] {
        let surface = super::super::modal::layout(area).surface;
        assert!(super::overlay_contains(
            &app,
            area,
            ratatui::layout::Position::new(surface.x, surface.y)
        ));
        let outside = ratatui::layout::Position::new(0, 0);
        if surface.contains(outside) {
            assert!(super::target_at(&app, area, 0, 0).is_none());
        } else {
            assert_eq!(
                super::target_at(&app, area, 0, 0),
                Some(PointerTarget::Modal(super::super::modal::Target::Backdrop))
            );
        }
        let selection = app.list_selection().unwrap();
        assert_eq!(selection.active_tab().label(), "First");
        assert_eq!(selection.selected_visible_index(), Some(0));
        assert_eq!(selection.query(), "");
    }
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert_eq!(
        app.list_selection().unwrap().selected_visible_index(),
        Some(1)
    );
    app.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Char('2'), KeyModifiers::NONE));
    assert_eq!(app.list_selection().unwrap().query(), "2");
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_none());
}

fn assert_base_pointer_targets(app: &mut App, area: Rect) {
    assert_eq!(app.mouse_mode(), MouseMode::TuiCapture);
    for row in area.y..area.bottom() {
        for column in area.x..area.right() {
            assert!(!super::overlay_contains(
                app,
                area,
                ratatui::layout::Position::new(column, row)
            ));
            match super::target_at(app, area, column, row) {
                Some(PointerTarget::Header(_))
                | Some(PointerTarget::Composer(ChatComposerPointerTarget::Input)) => {}
                None => assert_eq!(activate_pointer_item(app, area, column, row), None),
                target => panic!("unexpected base pointer target: {target:?}"),
            }
        }
    }
}

fn assert_terminal_selection(app: &mut App) {
    assert_eq!(app.mouse_mode(), MouseMode::TerminalSelection);
    app.fullscreen.clear();
    assert!(app.fullscreen.pointer.hovered().is_none());
    assert!(app.fullscreen.pointer.pressed().is_none());
    assert!(app.fullscreen.selection.range().is_none());
}

#[test]
fn main_screen_leaves_completion_clicks_to_terminal_and_keeps_keyboard_navigation() {
    let mut app = App::new();
    app.insert_text("/q");
    let area = Rect::new(0, 0, 80, 24);
    let target = (0..area.height)
        .flat_map(|row| (0..area.width).map(move |column| (column, row)))
        .find(|(column, row)| {
            matches!(
                super::target_at(&app, area, *column, *row),
                Some(PointerTarget::Composer(_))
            )
        })
        .expect("completion is clickable");
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_screen_mode(crate::terminal::ScreenMode::Inline);
    app.update(crate::config::Event::SettingsReceived(settings));
    assert_terminal_selection(&mut app);
    assert_eq!(app.input(), "/q");
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Quit)
    );

    let mut app = App::new();
    app.insert_text("/q");
    assert_eq!(
        activate_pointer_item(&mut app, area, target.0, target.1),
        Some(AppCommand::Quit)
    );
}

#[test]
fn detail_overlay_captures_only_its_surface_and_releases_mouse_on_close() {
    let mut app = App::new();
    let area = Rect::new(0, 0, 80, 24);
    let before = crate::app::fullscreen::layout(&app, area).session.composer;
    app.show_overlay(crate::widgets::detail_list::DetailList::new(
        "Output",
        vec![crate::widgets::detail_list::DetailListRow::new(
            "stdout", "details",
        )],
    ));
    assert_eq!(
        crate::app::fullscreen::layout(&app, area).session.composer,
        before
    );
    assert_eq!(app.mouse_mode(), MouseMode::TuiCapture);
    let surface = super::super::modal::layout(area).surface;
    let close = super::super::modal::layout(area).close;
    update_pointer_hover(&mut app, area, close.x, close.y);
    let mut terminal =
        ratatui::Terminal::new(ratatui::backend::TestBackend::new(area.width, area.height))
            .unwrap();
    terminal.draw(|frame| frame::draw(frame, &app)).unwrap();
    for column in close.x..close.right() {
        assert_eq!(
            terminal.backend().buffer()[(column, close.y)].bg,
            app.render_context().hover_background()
        );
    }
    for row in 0..area.height {
        for column in 0..area.width {
            let position = ratatui::layout::Position::new(column, row);
            assert_eq!(
                super::overlay_contains(&app, area, position),
                surface.contains(position)
            );
            if close.contains(position) {
                assert_eq!(
                    super::target_at(&app, area, column, row),
                    Some(PointerTarget::Modal(super::super::modal::Target::Close))
                );
            } else if surface.contains(position) {
                assert_eq!(super::target_at(&app, area, column, row), None);
            } else {
                assert_eq!(
                    super::target_at(&app, area, column, row),
                    Some(PointerTarget::Modal(super::super::modal::Target::Backdrop))
                );
            }
        }
    }
    let outside = ratatui::layout::Position::new(area.x, area.y);
    assert!(!surface.contains(outside));
    assert_eq!(
        activate_pointer_item(&mut app, area, outside.x, outside.y),
        None
    );
    assert!(app.overlay().is_none());
    assert_base_pointer_targets(&mut app, area);
}

#[test]
fn pointer_move_tracks_hover_without_changing_the_keyboard_completion() {
    let mut app = App::new();
    app.insert_text("/");
    let area = Rect::new(0, 0, 80, 20);
    let third_completion_row = crate::app::fullscreen::layout(&app, area).input.y - 4;

    update_pointer_hover(&mut app, area, 2, third_completion_row);
    assert!(matches!(app.completion(), Some(CompletionView::Slash(view)) if view.selected == 0));
    assert!(matches!(
        app.fullscreen.pointer.hovered(),
        Some(PointerTarget::Composer(
            ChatComposerPointerTarget::CompletionItem(2)
        ))
    ));

    update_pointer_hover(&mut app, area, 1, third_completion_row);
    assert!(matches!(app.completion(), Some(CompletionView::Slash(view)) if view.selected == 0));
    assert!(app.fullscreen.pointer.hovered().is_none());
}

#[test]
fn mouse_wheel_scrolls_the_slash_command_completion() {
    let mut app = App::new();
    app.insert_text("/");
    let area = Rect::new(0, 0, 80, 20);
    let popup_row = crate::app::fullscreen::layout(&app, area).input.y - 1;

    assert!(matches!(app.completion(), Some(CompletionView::Slash(view)) if view.selected == 0));
    assert!(matches!(
        handle_mouse(
            &mut app,
            area,
            MouseEvent {
                kind: MouseEventKind::ScrollDown,
                column: 79,
                row: popup_row,
                modifiers: KeyModifiers::NONE,
            },
        ),
        super::MouseAction::Command(None)
    ));
    assert!(matches!(app.completion(), Some(CompletionView::Slash(view)) if view.selected == 1));

    handle_mouse(
        &mut app,
        area,
        MouseEvent {
            kind: MouseEventKind::ScrollUp,
            column: 2,
            row: popup_row,
            modifiers: KeyModifiers::NONE,
        },
    );
    assert!(matches!(app.completion(), Some(CompletionView::Slash(view)) if view.selected == 0));
}

#[test]
fn session_manager_items_hover_and_activate_without_changing_the_draft() {
    let mut app = App::new();
    let session_id = SessionId::new("pointer-session").unwrap();
    let thread_id = ThreadId::new("pointer-thread").unwrap();
    app.update(SessionEvent::CatalogReceived(vec![Session {
        session_id: session_id.clone(),
        title: "Pointer session".into(),
        status: SessionStatus::Active,
        manager: SessionManagerInfo::default(),
        threads: vec![SessionThread {
            thread_id: thread_id.clone(),
            title: "Pointer thread".into(),
            created_at_unix_ms: 0,
            completed_turn_duration_ms: 0,
            active_turn_started_at_unix_ms: None,
            usage: Default::default(),
            parent_thread_id: None,
            forked_from_id: None,
            status: ThreadStatus::Active,
        }],
    }]));
    app.update(ThreadEvent::ContextChanged {
        session_id,
        thread_id,
    });
    app.insert_text("/dashboard");
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    let area = Rect::new(0, 0, 80, 24);
    app.insert_text("keep this draft");
    let target = (0..area.height)
        .flat_map(|row| (0..area.width).map(move |column| (column, row)))
        .find(|(column, row)| {
            matches!(
                super::target_at(&app, area, *column, *row),
                Some(PointerTarget::SessionManager(
                    crate::sessions::SessionManagerPointerTarget::Session(id)
                )) if id.as_str() == "pointer-session"
            )
        })
        .expect("the visible session row is pointer-addressable");
    update_pointer_hover(&mut app, area, target.0, target.1);
    assert!(matches!(
        app.fullscreen.pointer.hovered(),
        Some(PointerTarget::SessionManager(
            crate::sessions::SessionManagerPointerTarget::Session(id)
        )) if id.as_str() == "pointer-session"
    ));
    assert!(!app.session_manager_focused());
    assert!(app.session_preview().is_none());
    assert!(app.session_manager_view().is_some());
    assert_eq!(app.input(), "keep this draft");
    assert!(matches!(
        activate_pointer_item(&mut app, area, target.0, target.1),
        Some(AppCommand::Sessions(SessionCommand::Resume { session_id, .. }))
            if session_id == "pointer-session"
    ));
    assert!(app.session_manager_focused());
    assert_eq!(app.input(), "keep this draft");
}

#[test]
fn mouse_wheel_scrolls_the_full_screen_transcript() {
    let mut app = App::new();
    for index in 0..12 {
        app.update(ThreadEvent::FailureReported(format!("failure {index}")));
    }
    let area = Rect::new(0, 0, 50, 16);
    let transcript = crate::app::fullscreen::layout(&app, area)
        .session
        .transcript;

    assert!(matches!(
        handle_mouse(
            &mut app,
            area,
            MouseEvent {
                kind: MouseEventKind::ScrollUp,
                column: transcript.x,
                row: transcript.y,
                modifiers: KeyModifiers::NONE,
            }
        ),
        super::MouseAction::Command(None)
    ));
    assert!(app.transcript_scroll().anchor().is_some());
    app.handle_key_in_area(KeyEvent::new(KeyCode::End, KeyModifiers::CONTROL), area);
    assert!(app.transcript_scroll().anchor().is_none());

    app.update(AppEvent::HelpOpened(ListSelectionModel::new(
        "Help",
        vec![ListSelectionGroup::new(
            "Commands",
            vec![ListSelectionItem::new("Help")],
        )],
    )));
    let panel = crate::app::fullscreen::layout(&app, area).session.composer;
    assert!(matches!(
        handle_mouse(
            &mut app,
            area,
            MouseEvent {
                kind: MouseEventKind::ScrollUp,
                column: panel.x,
                row: panel.y,
                modifiers: KeyModifiers::NONE,
            }
        ),
        super::MouseAction::Selection(None)
    ));
    assert!(app.transcript_scroll().anchor().is_none());
}

#[test]
fn main_screen_leaves_wheel_input_to_terminal() {
    let mut app = App::new();
    for index in 0..12 {
        app.update(ThreadEvent::FailureReported(format!("failure {index}")));
    }
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_screen_mode(crate::terminal::ScreenMode::Inline);
    app.update(crate::config::Event::SettingsReceived(settings));
    let area = Rect::new(0, 0, 50, 16);
    let transcript = crate::app::fullscreen::layout(&app, area)
        .session
        .transcript;

    assert!(matches!(
        handle_mouse(
            &mut app,
            area,
            MouseEvent {
                kind: MouseEventKind::ScrollUp,
                column: transcript.x,
                row: transcript.y,
                modifiers: KeyModifiers::NONE,
            }
        ),
        super::MouseAction::Selection(None)
    ));
    assert!(app.transcript_scroll().anchor().is_none());
    assert_terminal_selection(&mut app);
}

#[test]
fn fullscreen_drag_produces_a_selection_without_a_separate_setting() {
    let mut app = App::new();
    let area = Rect::new(0, 0, 50, 16);
    let event = |kind, column| MouseEvent {
        kind,
        column,
        row: 1,
        modifiers: KeyModifiers::NONE,
    };

    handle_mouse(
        &mut app,
        area,
        event(MouseEventKind::Down(MouseButton::Left), 2),
    );
    handle_mouse(
        &mut app,
        area,
        event(MouseEventKind::Drag(MouseButton::Left), 8),
    );
    let outcome = handle_mouse(
        &mut app,
        area,
        event(MouseEventKind::Up(MouseButton::Left), 8),
    );

    assert!(matches!(
        outcome,
        super::MouseAction::Selection(Some(
            crate::app::fullscreen::selection::ScreenSelectionOutcome::Selection(_)
        ))
    ));
    assert!(app.fullscreen.pointer.hovered().is_none());
    assert!(app.fullscreen.pointer.pressed().is_none());
}

#[test]
fn overlays_block_background_wheel_and_selection_until_dismissed() {
    for detail in [false, true] {
        let mut app = App::new();
        let area = Rect::new(0, 0, 80, 24);
        for index in 0..30 {
            app.update(ThreadEvent::FailureReported(format!("failure {index}")));
        }
        app.handle_key_in_area(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE), area);
        let anchor = app.transcript_scroll().anchor().cloned();
        if detail {
            app.show_overlay(crate::widgets::detail_list::DetailList::new(
                "Output",
                vec![crate::widgets::detail_list::DetailListRow::new(
                    "stdout", "details",
                )],
            ));
        } else {
            app.insert_text("/q");
            assert!(app.completion_visible());
        }
        let transcript = crate::app::fullscreen::layout(&app, area)
            .session
            .transcript;
        let outside = (transcript.y..transcript.bottom())
            .map(|row| ratatui::layout::Position::new(transcript.x, row))
            .find(|position| !super::overlay_contains(&app, area, *position))
            .unwrap();
        for kind in [
            MouseEventKind::ScrollUp,
            MouseEventKind::ScrollDown,
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Drag(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
        ] {
            assert!(matches!(
                handle_mouse(
                    &mut app,
                    area,
                    MouseEvent {
                        kind,
                        column: outside.x,
                        row: outside.y,
                        modifiers: KeyModifiers::NONE,
                    }
                ),
                super::MouseAction::Selection(None)
            ));
            assert!(app.fullscreen.selection.range().is_none());
            if !detail || kind != MouseEventKind::Down(MouseButton::Left) {
                assert!(app.fullscreen.pointer.pressed().is_none());
            } else {
                assert_eq!(
                    app.fullscreen.pointer.pressed(),
                    Some(&PointerTarget::Modal(super::super::modal::Target::Backdrop))
                );
            }
            assert_eq!(app.transcript_scroll().anchor(), anchor.as_ref());
        }
        let inside = (0..area.height)
            .flat_map(|row| {
                (0..area.width).map(move |column| ratatui::layout::Position::new(column, row))
            })
            .find(|position| super::overlay_contains(&app, area, *position))
            .unwrap();
        handle_mouse(
            &mut app,
            area,
            MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: inside.x,
                row: inside.y,
                modifiers: KeyModifiers::NONE,
            },
        );
        handle_mouse(
            &mut app,
            area,
            MouseEvent {
                kind: MouseEventKind::Drag(MouseButton::Left),
                column: outside.x,
                row: outside.y,
                modifiers: KeyModifiers::NONE,
            },
        );
        assert!(app.fullscreen.selection.range().is_none());
        assert!(matches!(
            handle_mouse(
                &mut app,
                area,
                MouseEvent {
                    kind: MouseEventKind::Up(MouseButton::Left),
                    column: inside.x,
                    row: inside.y,
                    modifiers: KeyModifiers::NONE
                }
            ),
            super::MouseAction::Selection(None)
        ));
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        handle_mouse(
            &mut app,
            area,
            MouseEvent {
                kind: MouseEventKind::ScrollDown,
                column: outside.x,
                row: outside.y,
                modifiers: KeyModifiers::NONE,
            },
        );
        assert_ne!(app.transcript_scroll().anchor(), anchor.as_ref());
    }
}

#[test]
fn detail_overlay_still_scrolls_its_own_content_with_the_mouse() {
    let mut app = App::new();
    let area = Rect::new(0, 0, 80, 24);
    app.show_overlay(crate::widgets::detail_list::DetailList::new(
        "Output",
        vec![crate::widgets::detail_list::DetailListRow::new(
            "stdout",
            (0..40)
                .map(|index| format!("line {index:02}"))
                .collect::<Vec<_>>()
                .join("\n"),
        )],
    ));
    let surface = super::super::modal::layout(area).surface;
    let render = |app: &App| {
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(area.width, area.height))
                .unwrap();
        terminal.draw(|frame| frame::draw(frame, app)).unwrap();
        terminal.backend().to_string()
    };
    let before = render(&app);
    handle_mouse(
        &mut app,
        area,
        MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: surface.x,
            row: surface.y + 1,
            modifiers: KeyModifiers::NONE,
        },
    );
    assert_ne!(render(&app), before);
    assert!(app.transcript_scroll().anchor().is_none());
}

#[test]
fn issue_manager_blocks_background_transcript_scroll_and_clicks() {
    let mut app = App::new();
    let area = Rect::new(0, 0, 80, 24);
    for index in 0..30 {
        app.update(ThreadEvent::FailureReported(format!("failure {index}")));
    }
    app.handle_key_in_area(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE), area);
    let anchor = app.transcript_scroll().anchor().cloned();
    assert!(anchor.is_some());
    app.insert_text("/issue");
    assert!(matches!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Issues(_))
    ));
    assert!(app.issue_manager().is_some());
    let content = crate::app::fullscreen::layout(&app, area)
        .session
        .transcript;
    handle_mouse(
        &mut app,
        area,
        MouseEvent {
            kind: MouseEventKind::ScrollUp,
            column: content.x,
            row: content.y,
            modifiers: KeyModifiers::NONE,
        },
    );
    for column in content.x..content.right() {
        assert!(super::target_at(&app, area, column, content.bottom() - 1).is_none());
        activate_pointer_item(&mut app, area, column, content.bottom() - 1);
    }
    assert_eq!(app.transcript_scroll().anchor(), anchor.as_ref());
}

#[test]
fn jump_control_click_and_keyboard_restore_latest_without_changing_the_draft() {
    for width in [16, 50] {
        let mut app = App::new();
        for index in 0..12 {
            app.update(ThreadEvent::FailureReported(format!("failure {index}")));
        }
        app.insert_text("keep this draft");
        let area = Rect::new(0, 0, width, 16);
        app.handle_key_in_area(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE), area);
        let transcript = crate::app::fullscreen::layout(&app, area)
            .session
            .transcript;
        let row = transcript.bottom() - 1;
        let columns = (0..width)
            .filter(|column| {
                super::target_at(&app, area, *column, row)
                    == Some(PointerTarget::Transcript(
                        ChatHistoryPointerTarget::JumpToBottom,
                    ))
            })
            .collect::<Vec<_>>();
        assert!(!columns.is_empty());
        for column in [columns[0], *columns.last().unwrap()] {
            app.handle_key_in_area(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE), area);
            let event = |kind| MouseEvent {
                kind,
                column,
                row,
                modifiers: KeyModifiers::NONE,
            };
            handle_mouse(&mut app, area, event(MouseEventKind::Moved));
            assert_eq!(
                app.fullscreen.pointer.hovered(),
                Some(&PointerTarget::Transcript(
                    ChatHistoryPointerTarget::JumpToBottom
                ))
            );
            handle_mouse(
                &mut app,
                area,
                event(MouseEventKind::Down(MouseButton::Left)),
            );
            assert_eq!(
                app.fullscreen.pointer.pressed(),
                Some(&PointerTarget::Transcript(
                    ChatHistoryPointerTarget::JumpToBottom
                ))
            );
            let super::MouseAction::Selection(Some(
                crate::app::fullscreen::selection::ScreenSelectionOutcome::Click {
                    position, ..
                },
            )) = handle_mouse(&mut app, area, event(MouseEventKind::Up(MouseButton::Left)))
            else {
                panic!("expected a click");
            };
            activate_pointer_item(&mut app, area, position.x, position.y);
            assert!(app.transcript_scroll().anchor().is_none());
            assert!(super::target_at(&app, area, column, row).is_none());
            assert_eq!(app.input(), "keep this draft");
        }
        app.handle_key_in_area(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE), area);
        let anchor = app.transcript_scroll().anchor().cloned();
        app.show_overlay(crate::widgets::detail_list::DetailList::new(
            "Output",
            vec![crate::widgets::detail_list::DetailListRow::new(
                "stdout", "details",
            )],
        ));
        activate_pointer_item(&mut app, area, columns[0], row);
        app.handle_key_in_area(KeyEvent::new(KeyCode::End, KeyModifiers::CONTROL), area);
        assert_eq!(app.transcript_scroll().anchor(), anchor.as_ref());
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        let mut settings = crate::config::TerminalSettings::default();
        settings.set_screen_mode(crate::terminal::ScreenMode::Inline);
        app.update(crate::config::Event::SettingsReceived(settings));
        assert!(app.transcript_scroll().anchor().is_none());
        app.handle_key_in_area(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE), area);
        let inline_anchor = app.transcript_scroll().anchor().cloned();
        activate_pointer_item(&mut app, area, columns[0], row);
        assert_eq!(app.transcript_scroll().anchor(), inline_anchor.as_ref());
        assert!(app.transcript_scroll().anchor().is_some());
        app.handle_key_in_area(KeyEvent::new(KeyCode::End, KeyModifiers::CONTROL), area);
        assert!(app.transcript_scroll().anchor().is_none());
    }
}
#[test]
fn transcript_keyboard_navigation_still_requests_older_history() {
    let mut app = App::new();
    app.update(ThreadEvent::FailureReported("only loaded message".into()));
    let area = Rect::new(0, 0, 50, 16);

    assert_eq!(
        app.navigate_transcript(TranscriptScrollDirection::Up, area),
        Some(AppCommand::Thread(ThreadCommand::LoadOlderHistory))
    );
    assert!(app.transcript_scroll().anchor().is_some());
}

#[test]
fn switching_to_main_screen_during_a_drag_discards_the_pending_copy() {
    let mut app = App::new();
    app.insert_text("/");
    let area = Rect::new(0, 0, 80, 24);
    let row = crate::app::fullscreen::layout(&app, area).input.y - 1;
    let event = |kind, column| MouseEvent {
        kind,
        column,
        row,
        modifiers: KeyModifiers::NONE,
    };
    handle_mouse(&mut app, area, event(MouseEventKind::Moved, 2));
    handle_mouse(
        &mut app,
        area,
        event(MouseEventKind::Down(MouseButton::Left), 2),
    );
    assert!(app.fullscreen.pointer.hovered().is_some());
    assert!(app.fullscreen.pointer.pressed().is_some());
    handle_mouse(
        &mut app,
        area,
        event(MouseEventKind::Drag(MouseButton::Left), 8),
    );
    assert!(app.fullscreen.selection.range().is_some());
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_screen_mode(crate::terminal::ScreenMode::Inline);
    app.update(crate::config::Event::SettingsReceived(settings));
    assert!(matches!(
        handle_mouse(
            &mut app,
            area,
            event(MouseEventKind::Up(MouseButton::Left), 8)
        ),
        super::MouseAction::Selection(None)
    ));
    assert_eq!(app.mouse_mode(), MouseMode::TerminalSelection);
    assert!(app.fullscreen.pointer.hovered().is_none());
    assert!(app.fullscreen.pointer.pressed().is_none());
    assert!(app.fullscreen.selection.range().is_none());
    assert_eq!(app.input(), "/");
}

use super::PointerInteraction;

#[test]
fn pointer_hover_is_transient_and_has_no_selection_side_effect() {
    let mut pointer = PointerInteraction::default();

    pointer.update_hover(Some("second"));
    assert_eq!(pointer.hovered(), Some(&"second"));
    pointer.update_pressed(Some("second"));
    assert_eq!(pointer.pressed(), Some(&"second"));

    pointer.cancel_click();
    assert_eq!(pointer.hovered(), Some(&"second"));
    assert_eq!(pointer.pressed(), None);
    pointer.clear();
    assert_eq!(pointer.pressed(), None);
}

#[test]
fn completed_clicks_pair_by_target_and_time_and_cancel_on_drag_or_missed_release() {
    use crate::widgets::list_selection::ListSelectionClick;
    use std::time::Duration;
    use std::time::Instant;
    let mut pointer = super::PointerInteraction::default();
    let start = Instant::now();
    for (target, millis, expected) in [
        (1, 0, ListSelectionClick::Single),
        (1, 501, ListSelectionClick::Single),
        (2, 550, ListSelectionClick::Single),
        (2, 600, ListSelectionClick::Double),
        (2, 650, ListSelectionClick::Single),
    ] {
        pointer.update_pressed(Some(target));
        assert_eq!(
            pointer.finish_click(Some(target), start + Duration::from_millis(millis)),
            Some(expected)
        );
    }
    pointer.update_pressed(Some(2));
    pointer.cancel_click();
    assert_eq!(
        pointer.finish_click(Some(2), start + Duration::from_millis(700)),
        None
    );
    pointer.update_pressed(Some(2));
    assert_eq!(
        pointer.finish_click(Some(2), start + Duration::from_millis(750)),
        Some(ListSelectionClick::Single)
    );
    pointer.update_pressed(Some(2));
    assert_eq!(
        pointer.finish_click(Some(3), start + Duration::from_millis(800)),
        None
    );
    pointer.update_pressed(Some(2));
    assert_eq!(
        pointer.finish_click(Some(2), start + Duration::from_millis(850)),
        Some(ListSelectionClick::Single)
    );
    pointer.clear();
    pointer.update_pressed(Some(2));
    assert_eq!(
        pointer.finish_click(Some(2), start + Duration::from_millis(900)),
        Some(ListSelectionClick::Single)
    );
}
