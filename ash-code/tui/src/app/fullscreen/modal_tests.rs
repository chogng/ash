use crate::render::test_context;
use crate::theme::ThemePickerCatalog;
use crate::theme::ThemePickerChoice;
use crate::theme::ThemePickerTarget;
use crate::theme::ThemePreviewPalette;
use crate::theme::theme_choices;
use crate::widgets::list_selection::ListSelectionInputOutcome;
use crate::widgets::list_selection::ListSelectionState;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use crossterm::event::MouseButton;
use crossterm::event::MouseEvent;
use crossterm::event::MouseEventKind;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::layout::Rect;
use ratatui::style::Color;
use ratatui::style::Modifier;

fn palette(focus: Color) -> ThemePreviewPalette {
    ThemePreviewPalette {
        background: Color::Black,
        border: Color::Gray,
        foreground: Color::White,
        muted: Color::DarkGray,
        focus,
        selection_foreground: focus,
        keyword: Color::Red,
        string: Color::Blue,
        function: Color::Magenta,
        r#type: Color::Cyan,
        variable: Color::Yellow,
        inserted_background: Color::Green,
        removed_background: Color::Red,
        inserted_marker: Color::LightGreen,
        removed_marker: Color::LightRed,
    }
}

fn catalog() -> ThemePickerCatalog {
    let labels = [
        "Auto (match terminal)",
        "Dark mode",
        "Light mode",
        "Dark mode (colorblind-friendly)",
        "Light mode (colorblind-friendly)",
        "Dark mode (ANSI colors only)",
        "Light mode (ANSI colors only)",
    ];
    let mut choices = labels
        .into_iter()
        .enumerate()
        .map(|(index, label)| ThemePickerChoice {
            label: label.into(),
            palette_label: format!("Palette {index}"),
            target: ThemePickerTarget::Preference(format!("theme-{index}")),
            palette: palette(Color::Indexed(index as u8)),
            selected: index == 1,
        })
        .collect::<Vec<_>>();
    choices.push(ThemePickerChoice {
        label: "Custom color theme".into(),
        palette_label: "User-defined".into(),
        target: ThemePickerTarget::CustomThemes,
        palette: palette(Color::Magenta),
        selected: false,
    });
    ThemePickerCatalog {
        choices,
        custom_choices: vec![ThemePickerChoice {
            label: "Aurora".into(),
            palette_label: "User-defined · Aurora".into(),
            target: ThemePickerTarget::Preference("aurora".into()),
            palette: palette(Color::Cyan),
            selected: false,
        }],
    }
}

#[test]
fn theme_picker_is_numbered_fixed_and_not_searchable() {
    let view = theme_choices(&catalog());
    let model = view.model.clone();
    let mut state = ListSelectionState::new(model);

    assert_eq!(state.title(), "Theme");
    assert!(!state.show_tabs());
    assert_eq!(state.visible_items().len(), 8);
    assert_eq!(state.visible_items()[0].label(), "1. Auto (match terminal)");
    assert_eq!(state.visible_items()[1].label(), "2. Dark mode");
    assert_eq!(state.visible_items()[7].label(), "8. Custom color theme");
    assert_eq!(state.selected_visible_index(), Some(1));
    assert_eq!(
        state.selected_item().unwrap().selection_foreground(),
        Some(Color::Indexed(1))
    );
    let preview = state.selected_item().unwrap().preview().unwrap();
    assert_eq!(preview.title(), "Diff preview");
    assert_eq!(preview.lines().len(), 4);
    let preview_text = preview
        .lines()
        .iter()
        .map(|line| {
            line.spans
                .iter()
                .map(|span| span.content.as_ref() as &str)
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    assert!(preview_text[0].starts_with("1   fn greet(ash:"));
    assert!(preview_text[1].starts_with("2  -"));
    assert!(preview_text[2].starts_with("2  +"));
    assert!(preview_text[3].starts_with("3"));
    let caption = preview
        .caption()
        .unwrap()
        .spans
        .iter()
        .map(|span| span.content.as_ref() as &str)
        .collect::<String>();
    assert_eq!(caption, "Syntax palette: Palette 1");
    let panel = crate::app::CommandPanel::theme(view);
    let key_hints = panel.key_hints().text().to_owned();
    assert_eq!(key_hints, "Enter to apply  ·  Esc to close");
    let height = 28;
    let mut terminal = Terminal::new(TestBackend::new(80, height)).unwrap();
    let layout = super::layout(ratatui::layout::Rect::new(0, 0, 80, height));
    terminal
        .draw(|frame| {
            super::draw_panel(
                frame,
                &panel,
                layout,
                None,
                None,
                crate::render::InteractionState::default(),
                false,
                crate::config::KeyHintStyle::Contrast,
                test_context(),
            )
        })
        .unwrap();
    let buffer = terminal.backend().buffer().clone();
    let rows = (0..height)
        .map(|row| {
            (0..80)
                .map(|column| buffer[(column, row)].symbol())
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    let rendered = rows.join("\n");
    let title_row = rows.iter().position(|row| row.contains("Theme")).unwrap();
    let first_choice_row = rows
        .iter()
        .position(|row| row.contains("1. Auto (match terminal)"))
        .unwrap();
    assert!(rendered.contains("Diff preview"));
    assert!(rendered.contains("Syntax palette: Palette 1"));
    assert!(rendered.contains('╌'));
    crate::tui_assert_snapshot!("theme_modal_preview", rendered);
    assert!(rendered.contains('┌'));
    assert!(rendered.contains('┘'));
    assert_eq!(title_row, usize::from(layout.surface.y));
    assert_eq!(first_choice_row - title_row, 2);
    let hover = super::Target::List(
        crate::widgets::list_selection::ListSelectionPointerTarget::Item(
            panel.list_selection().unwrap().visible_items()[0]
                .id()
                .unwrap()
                .clone(),
        ),
    );
    terminal
        .draw(|frame| {
            super::draw_panel(
                frame,
                &panel,
                layout,
                Some(&hover),
                None,
                crate::render::InteractionState::default(),
                false,
                crate::config::KeyHintStyle::Contrast,
                test_context(),
            )
        })
        .unwrap();
    assert_eq!(
        terminal.backend().buffer()[(layout.content.x, first_choice_row as u16)].bg,
        test_context().hover_background()
    );
    assert_eq!(
        terminal.backend().buffer()[(layout.content.x, first_choice_row as u16 + 1)].bg,
        test_context().selection_background()
    );
    let custom_row = rows
        .iter()
        .position(|row| row.contains("8. Custom color theme"))
        .unwrap();
    let preview_row = rows
        .iter()
        .position(|row| row.contains("Diff preview"))
        .unwrap();
    let palette_row = rows
        .iter()
        .position(|row| row.contains("Syntax palette"))
        .unwrap();
    let key_hint_row = rows
        .iter()
        .position(|row| row.contains("Enter to apply  ·  Esc to close"))
        .unwrap();
    assert!(
        preview_row >= custom_row + 2,
        "the preview is separated from the selectable list"
    );
    assert!(key_hint_row > palette_row);
    assert_eq!(
        buffer[(layout.title.x + 1, layout.title.y)].fg,
        test_context().foreground()
    );
    assert!(
        buffer[(layout.title.x + 1, layout.title.y)]
            .modifier
            .contains(Modifier::BOLD)
    );
    assert_ne!(
        buffer[(layout.title.x + 1, layout.title.y)].bg,
        test_context().accent_surface_background()
    );
    assert_eq!(
        buffer[(layout.content.x, preview_row as u16)].fg,
        Color::DarkGray
    );

    assert_eq!(
        state.handle_key(KeyEvent::new(KeyCode::Char(' '), KeyModifiers::NONE)),
        ListSelectionInputOutcome::Consumed
    );
    assert!(state.search().is_none());
    assert_eq!(state.query(), "");
}

fn config_choices() -> crate::config::ConfigChoices {
    crate::config::config_choices(
        &crate::test_support::empty_config_snapshot(),
        &ash_app_server_protocol::protocol::provider::ProviderListResult {
            providers: Vec::new(),
        },
        crate::config::TerminalSettings::default(),
        crate::status::StatusLineSettings::default(),
    )
}

fn frame_text(app: &crate::app::App) -> String {
    let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
    terminal
        .draw(|frame| crate::app::frame::draw(frame, app))
        .unwrap();
    terminal
        .backend()
        .buffer()
        .content
        .chunks(100)
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn modal_restores_home_focus_and_survives_background_thread_updates() {
    let mut app = crate::app::App::new();
    app.open_home();
    app.insert_text("preserved draft");
    app.update(crate::config::Event::EditorOpened(config_choices()));
    assert!(!app.chat_input_focused());
    app.update(crate::thread::Event::ContextChanged {
        session_id: ash_protocol::SessionId::new("tui-session").unwrap(),
        thread_id: ash_protocol::ThreadId::new("tui-local").unwrap(),
    });
    assert!(app.fullscreen_home_visible());
    assert!(app.command_panel().is_some());
    app.handle_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE));
    assert_eq!(app.input(), "preserved draft");
    crate::tui_assert_snapshot!("settings_on_home", frame_text(&app));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_none());
    assert_eq!(app.fullscreen.home.selected, None);
    assert!(app.chat_input_focused());
    assert_eq!(app.input(), "preserved draft");
    crate::tui_assert_snapshot!("home_after_modal_closed", frame_text(&app));
}

#[test]
fn delayed_editor_results_do_not_reopen_or_replace_a_new_modal() {
    use crate::app::command_panel::CommandPanel;
    let mut app = crate::app::App::new();
    app.open_command_panel(CommandPanel::loading("Settings", "Loading…"));
    let generation = app.panels().generation();
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    app.update_for_panel(
        generation,
        crate::config::Event::EditorOpened(config_choices()),
    );
    assert!(app.command_panel().is_none());
    app.open_command_panel(CommandPanel::loading("Model", "Loading…"));
    app.update_for_panel(
        generation,
        crate::config::Event::EditorOpened(config_choices()),
    );
    assert_eq!(app.command_panel().unwrap().body().title(), "Model");
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_screen_mode(crate::terminal::ScreenMode::Inline);
    app.update_for_panel(
        generation,
        crate::config::Event::Updated(crate::config::ConfigEditResult {
            terminal: settings,
            status_line: crate::status::StatusLineSettings::default(),
            choices: config_choices(),
        }),
    );
    assert_eq!(app.screen_mode(), crate::terminal::ScreenMode::Inline);
    assert_eq!(app.command_panel().unwrap().body().title(), "Model");
}

#[test]
fn modal_mouse_activation_uses_the_session_identity_and_close_requires_matching_press() {
    use crate::app::AppCommand;
    use crate::app::fullscreen::pointer::MouseAction;
    use crossterm::event::MouseButton;
    use crossterm::event::MouseEvent;
    use crossterm::event::MouseEventKind;
    use ratatui::layout::Rect;
    let mut app = crate::app::App::new();
    let choices = crate::sessions::session_choices(
        &[ash_protocol::Session {
            session_id: ash_protocol::SessionId::new("session-1").unwrap(),
            title: "Resume this work".into(),
            status: ash_protocol::SessionStatus::Active,
            manager: Default::default(),
            threads: Vec::new(),
        }],
        None,
    );
    app.update(crate::sessions::Event::PickerOpened(choices));
    let area = Rect::new(0, 0, 100, 30);
    let item = (0..area.height)
        .flat_map(|y| (0..area.width).map(move |x| (x, y)))
        .find(|(x, y)| {
            matches!(
                super::target_at(&app, area, ratatui::layout::Position::new(*x, *y)),
                Some(super::Target::List(
                    crate::widgets::list_selection::ListSelectionPointerTarget::Item(_)
                ))
            )
        })
        .unwrap();
    let mouse = |kind, (column, row)| MouseEvent {
        kind,
        column,
        row,
        modifiers: KeyModifiers::NONE,
    };
    crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Down(MouseButton::Left), item),
    );
    let outcome = crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Up(MouseButton::Left), item),
    );
    assert!(
        matches!(outcome, MouseAction::Command(Some(AppCommand::Sessions(crate::sessions::Command::Resume { session_id, .. }))) if session_id == "session-1")
    );
    let close = super::layout(area).close;
    let close = (close.x, close.y);
    crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Moved, close),
    );
    let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
    terminal
        .draw(|frame| crate::app::frame::draw(frame, &app))
        .unwrap();
    for column in super::layout(area).close.x..super::layout(area).close.right() {
        assert_eq!(
            terminal.backend().buffer()[(column, close.1)].bg,
            app.render_context().hover_background()
        );
    }
    crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Down(MouseButton::Left), close),
    );
    terminal
        .draw(|frame| crate::app::frame::draw(frame, &app))
        .unwrap();
    for column in super::layout(area).close.x..super::layout(area).close.right() {
        assert_eq!(
            terminal.backend().buffer()[(column, close.1)].bg,
            app.render_context().pressed_background()
        );
    }
    app.fullscreen.clear();
    crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Up(MouseButton::Left), close),
    );
    assert!(app.command_panel().is_some());
    crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Down(MouseButton::Left), close),
    );
    crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Up(MouseButton::Left), close),
    );
    assert!(app.command_panel().is_none());
}

#[test]
fn modal_backdrop_click_closes_modal_and_drag_cancels() {
    let mut app = crate::app::App::new();
    let choices = crate::sessions::session_choices(
        &[ash_protocol::Session {
            session_id: ash_protocol::SessionId::new("session-1").unwrap(),
            title: "Test session".into(),
            status: ash_protocol::SessionStatus::Active,
            manager: Default::default(),
            threads: Vec::new(),
        }],
        None,
    );
    app.update(crate::sessions::Event::PickerOpened(choices));
    assert!(app.command_panel().is_some());
    let area = Rect::new(0, 0, 100, 30);
    let modal = super::layout(area).surface;
    let outside = (area.x, area.y);
    let inside = (modal.x + 2, modal.y + 2);
    assert!(!modal.contains(ratatui::layout::Position::new(outside.0, outside.1)));
    assert!(modal.contains(ratatui::layout::Position::new(inside.0, inside.1)));

    let mouse = |kind, (column, row)| MouseEvent {
        kind,
        column,
        row,
        modifiers: KeyModifiers::NONE,
    };

    // Drag from outside to inside should cancel press and not close.
    crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Down(MouseButton::Left), outside),
    );
    crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Drag(MouseButton::Left), inside),
    );
    crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Up(MouseButton::Left), inside),
    );
    assert!(app.command_panel().is_some());

    // Drag from inside to outside should cancel press and not close.
    crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Down(MouseButton::Left), inside),
    );
    crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Drag(MouseButton::Left), outside),
    );
    crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Up(MouseButton::Left), outside),
    );
    assert!(app.command_panel().is_some());

    // Direct click on backdrop (Down + Up on outside) closes the modal.
    crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Down(MouseButton::Left), outside),
    );
    crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Up(MouseButton::Left), outside),
    );
    assert!(app.command_panel().is_none());
}

#[test]
fn editing_modal_blocks_backdrop_dismiss_and_protects_input() {
    use crate::memories::Event;
    use crate::memories::Page;
    use memories::MemoryPolicy;
    use memories::MemoryScope;
    let mut app = crate::app::App::new();
    app.update(Event::Opened(Page::List {
        policy: MemoryPolicy::disabled(MemoryScope::Profile),
        entries: Vec::new(),
        cursor: None,
    }));
    assert!(super::allows_backdrop_dismiss(&app));
    let area = Rect::new(0, 0, 100, 30);
    let modal = super::layout(area).surface;
    let outside = (area.x, area.y);
    assert!(!modal.contains(ratatui::layout::Position::new(outside.0, outside.1)));

    // Entering the multi-line editor turns the panel into an editing dialog.
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.handle_paste("Important draft".into());
    assert!(!super::allows_backdrop_dismiss(&app));
    assert_eq!(
        super::target_at(
            &app,
            area,
            ratatui::layout::Position::new(outside.0, outside.1)
        ),
        Some(super::Target::Blocked)
    );

    let mouse = |kind, (column, row)| MouseEvent {
        kind,
        column,
        row,
        modifiers: KeyModifiers::NONE,
    };

    // Pressing down on the blocked backdrop immediately triggers transient alert.
    crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Down(MouseButton::Left), outside),
    );
    assert_eq!(
        app.fullscreen.pointer.pressed(),
        Some(&crate::app::fullscreen::pointer::PointerTarget::Modal(
            super::Target::Blocked
        ))
    );
    let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
    terminal
        .draw(|frame| crate::app::frame::draw(frame, &app))
        .unwrap();
    assert_eq!(
        terminal.backend().buffer()[(modal.x, modal.y)].fg,
        app.render_context().warning()
    );

    // Releasing the click keeps the dialog open and maintains modal_alert feedback.
    crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Up(MouseButton::Left), outside),
    );
    assert!(app.command_panel().is_some());
    assert!(!super::allows_backdrop_dismiss(&app));
    assert!(app.fullscreen.modal_alert);

    // Frame rendered while alert is active shows warning border and "editing in progress" hint.
    terminal
        .draw(|frame| crate::app::frame::draw(frame, &app))
        .unwrap();
    assert_eq!(
        terminal.backend().buffer()[(modal.x, modal.y)].fg,
        app.render_context().warning()
    );
    let rows = (0..area.height)
        .map(|row| {
            (0..area.width)
                .map(|col| terminal.backend().buffer()[(col, row)].symbol())
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    assert!(
        rows.iter()
            .any(|row| row.contains("editing in progress") && row.contains("Esc to cancel"))
    );

    // Typing any key clears the alert while continuing to edit.
    app.handle_key(KeyEvent::new(KeyCode::Char('!'), KeyModifiers::NONE));
    assert!(!app.fullscreen.modal_alert);
    terminal
        .draw(|frame| crate::app::frame::draw(frame, &app))
        .unwrap();
    assert_eq!(
        terminal.backend().buffer()[(modal.x, modal.y)].fg,
        app.render_context().modal_border()
    );

    // Clicking inside the dialog also clears the alert if it was active.
    crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Down(MouseButton::Left), outside),
    );
    crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Up(MouseButton::Left), outside),
    );
    assert!(app.fullscreen.modal_alert);
    let inside = (modal.x + 2, modal.y + 2);
    crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Down(MouseButton::Left), inside),
    );
    assert!(!app.fullscreen.modal_alert);

    // Esc exits the editor and returns to the list picker.
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_some());
    assert!(super::allows_backdrop_dismiss(&app));

    // Now in list picker mode, clicking backdrop closes the dialog.
    crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Down(MouseButton::Left), outside),
    );
    crate::app::fullscreen::pointer::handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Up(MouseButton::Left), outside),
    );
    assert!(app.command_panel().is_none());
}

#[test]
fn detail_tabs_use_the_same_mouse_routing_as_list_tabs() {
    use crate::status::RemainingContextWindow;
    use crate::status::StatusViewData;
    let mut app = crate::app::App::new();
    app.update(crate::status::Event::PanelOpened(
        crate::status::status_panel(StatusViewData {
            model: "test/model",
            full_context_window: None,
            available_context_window: None,
            remaining_context_window: RemainingContextWindow::Unknown,
            usage: &ash_protocol::ModelUsageSummary::default(),
            reference_cost: &ash_protocol::ModelReferenceCostSummary::default(),
            session_id: "session",
            thread_id: "thread",
        }),
    ));
    let area = ratatui::layout::Rect::new(0, 0, 100, 30);
    let tab = (0..area.height)
        .flat_map(|y| (0..area.width).map(move |x| (x, y)))
        .find_map(|(x, y)| {
            match super::target_at(&app, area, ratatui::layout::Position::new(x, y)) {
                Some(target @ super::Target::Tab(1)) => Some(target),
                _ => None,
            }
        })
        .unwrap();
    assert_eq!(
        crate::app::frame::process_resource_demand(&app, area),
        ash_memory_diagnostics::ProcessResourceDemand::Disabled
    );
    assert_eq!(super::activate(&mut app, area, tab), None);
    assert_eq!(
        crate::app::frame::process_resource_demand(&app, area),
        ash_memory_diagnostics::ProcessResourceDemand::Detailed
    );
    crate::tui_assert_snapshot!("status_modal_processes", frame_text(&app));
}

#[test]
fn paste_targets_the_modal_and_home_instead_of_a_background_question() {
    use crate::thread::interaction::query::Query;
    use crate::thread::interaction::query::QueryChoice;
    use crate::thread::interaction::query::QueryCustomAnswer;
    use crate::thread::interaction::query::QueryQuestion;
    let mut app = crate::app::App::new();
    app.update(crate::thread::Event::QueryRequested(
        Query::new(vec![QueryQuestion {
            id: "question".into(),
            header: "Question".into(),
            prompt: "Choose an option".into(),
            choices: vec![QueryChoice {
                label: "Continue".into(),
                description: "Continue the task".into(),
            }],
            custom_answer: QueryCustomAnswer::Allowed,
        }])
        .unwrap(),
    ));
    app.update(crate::config::Event::EditorOpened(config_choices()));
    app.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));
    app.handle_paste("Screen mode".into());
    assert_eq!(app.list_selection().unwrap().query(), "Screen mode");
    assert_eq!(app.input(), "");
    assert!(app.query_view().unwrap().custom_answer.is_none());
    crate::tui_assert_snapshot!("modal_search_with_background_question", frame_text(&app));
    app.open_home();
    app.handle_paste("new task".into());
    assert_eq!(app.input(), "new task");
    assert!(app.chat_panel.query_view().unwrap().custom_answer.is_none());
}

#[test]
fn memories_manager_edits_multiline_text_keeps_failed_drafts_and_restores_home() {
    use crate::memories::Event;
    use crate::memories::Page;
    use memories::MemoryPolicy;
    use memories::MemoryScope;
    let mut app = crate::app::App::new();
    app.open_home();
    app.insert_text("background draft");
    app.update(Event::Opened(Page::List {
        policy: MemoryPolicy::disabled(MemoryScope::Profile),
        entries: Vec::new(),
        cursor: None,
    }));
    crate::tui_assert_snapshot!("memories_management", frame_text(&app));
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.handle_paste("Fixture decision".into());
    app.handle_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL));
    app.handle_paste("Use Rust\n保留  两个空格".into());
    crate::tui_assert_snapshot!("memories_multiline_editor", frame_text(&app));
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_screen_mode(crate::terminal::ScreenMode::Inline);
    app.update(crate::config::Event::SettingsReceived(settings.clone()));
    crate::tui_assert_snapshot!("memories_inline_editor", frame_text(&app));
    settings.set_screen_mode(crate::terminal::ScreenMode::Fullscreen);
    app.update(crate::config::Event::SettingsReceived(settings));
    let Some(crate::app::AppCommand::Memories(crate::memories::Command::Add {
        title, body, ..
    })) = app.handle_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL))
    else {
        panic!("save must emit a Memory command");
    };
    assert_eq!(title, "Fixture decision");
    assert_eq!(body, "Use Rust\n保留  两个空格");
    app.update(Event::Failed(
        "The memory changed in another window. Refresh before saving.".into(),
    ));
    crate::tui_assert_snapshot!("memories_failed_draft", frame_text(&app));
    let Some(crate::app::AppCommand::Memories(crate::memories::Command::Add { body, .. })) =
        app.handle_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL))
    else {
        panic!("failed save must retain the draft");
    };
    assert_eq!(body, "Use Rust\n保留  两个空格");
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_none());
    assert_eq!(app.input(), "background draft");
}

#[test]
fn provider_mouse_input_and_parent_title_return_to_config() {
    use crate::app::command_panel::CommandPanel;
    use crate::widgets::list_selection::ListSelectionItemId;
    use ratatui::layout::Position;
    let mut app = crate::app::App::new();
    app.open_home();
    app.update(crate::config::Event::EditorOpened(config_choices()));
    let Some(CommandPanel::Config(editor)) = app.fullscreen.panels.command_mut() else {
        panic!("config editor")
    };
    editor
        .selection_mut()
        .unwrap()
        .focus_item(&ListSelectionItemId::new("new-custom-provider"));
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    let area = Rect::new(0, 0, 100, 30);
    let layout = super::layout(area);
    let body = super::body_area(app.command_panel().unwrap(), layout.content);
    let position = Position::new(body.x + 4, body.y + 2);
    assert!(matches!(
        super::target_at(&app, area, position),
        Some(super::Target::Provider(_))
    ));
    for kind in [
        MouseEventKind::Down(MouseButton::Left),
        MouseEventKind::Up(MouseButton::Left),
    ] {
        crate::app::fullscreen::pointer::handle_mouse(
            &mut app,
            area,
            MouseEvent {
                kind,
                column: position.x,
                row: position.y,
                modifiers: KeyModifiers::NONE,
            },
        );
    }
    app.handle_key(KeyEvent::new(KeyCode::Char('N'), KeyModifiers::NONE));
    assert!(frame_text(&app).contains("│ N"));
    assert_eq!(app.input(), "");
    crate::tui_assert_snapshot!("provider_clicked_input", frame_text(&app));
    let parent = super::parent_area(layout, "Config");
    for pressed in [None, Some(&super::Target::Parent)] {
        let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
        terminal
            .draw(|frame| {
                super::draw_panel(
                    frame,
                    app.command_panel().unwrap(),
                    layout,
                    Some(&super::Target::Parent),
                    pressed,
                    Default::default(),
                    false,
                    Default::default(),
                    test_context(),
                )
            })
            .unwrap();
        let cell = &terminal.backend().buffer()[(parent.x, parent.y)];
        assert!(cell.modifier.contains(Modifier::UNDERLINED));
        assert_eq!(
            cell.fg,
            if pressed.is_some() {
                test_context().pressed_foreground()
            } else {
                test_context().hover_foreground()
            }
        );
        assert_eq!(
            cell.bg,
            if pressed.is_some() {
                test_context().pressed_background()
            } else {
                test_context().hover_background()
            }
        );
    }

    let target = super::target_at(&app, area, Position::new(parent.x, parent.y));
    assert_eq!(target, Some(super::Target::Parent));
    super::activate(&mut app, area, target.unwrap());
    assert_eq!(
        app.list_selection().unwrap().active_tab().label(),
        "Providers"
    );
    assert_eq!(
        app.list_selection().unwrap().selected_item().unwrap().id(),
        Some(&ListSelectionItemId::new("new-custom-provider"))
    );
    crate::tui_assert_snapshot!("provider_parent_restores_config", frame_text(&app));
}

#[test]
fn config_descriptions_expand_below_items_and_keep_mouse_targets_aligned() {
    use crate::widgets::list_selection::ListSelectionItemId;
    use crate::widgets::list_selection::ListSelectionPointerTarget;
    use ratatui::layout::Position;
    let mut app = crate::app::App::new();
    app.open_home();
    app.update(crate::config::Event::EditorOpened(config_choices()));
    let collapsed = frame_text(&app);
    assert!(!collapsed.contains("Use Vim editing"));
    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE))
            .is_none()
    );
    assert!(frame_text(&app).contains("Use Vim editing in ChatInput"));
    crate::tui_assert_snapshot!("config_expanded_description", frame_text(&app));
    let area = Rect::new(0, 0, 100, 30);
    let body = super::body_area(app.command_panel().unwrap(), super::layout(area).content);
    let first = body.y + crate::widgets::search_box::SEARCH_BOX_HEIGHT;
    assert_eq!(
        super::target_at(&app, area, Position::new(body.x + 3, first + 1)),
        None
    );
    assert_eq!(
        super::target_at(&app, area, Position::new(body.x + 3, first + 2)),
        Some(super::Target::List(ListSelectionPointerTarget::Item(
            ListSelectionItemId::new("memory-diagnostics")
        )))
    );
    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE))
            .is_none()
    );
    assert_eq!(frame_text(&app), collapsed);
}

#[test]
fn config_double_click_changes_the_selected_item_once() {
    use crate::app::fullscreen::pointer::MouseAction;
    let mut app = crate::app::App::new();
    app.open_home();
    app.update(crate::config::Event::EditorOpened(config_choices()));
    let area = Rect::new(0, 0, 100, 30);
    let body = super::body_area(app.command_panel().unwrap(), super::layout(area).content);
    let row = body.y + crate::widgets::search_box::SEARCH_BOX_HEIGHT + 1;
    for click in 0..2 {
        let event = |kind| MouseEvent {
            kind,
            column: body.x + 8,
            row,
            modifiers: KeyModifiers::NONE,
        };
        let down = crate::app::fullscreen::pointer::handle_mouse(
            &mut app,
            area,
            event(MouseEventKind::Down(MouseButton::Left)),
        );
        assert!(matches!(down, MouseAction::Selection(None)));
        let up = crate::app::fullscreen::pointer::handle_mouse(
            &mut app,
            area,
            event(MouseEventKind::Up(MouseButton::Left)),
        );
        if click == 0 {
            assert!(matches!(up, MouseAction::Command(None)));
            assert_eq!(
                app.list_selection().unwrap().selected_item().unwrap().id(),
                Some(&crate::widgets::list_selection::ListSelectionItemId::new(
                    "memory-diagnostics"
                ))
            );
        } else {
            let MouseAction::Command(Some(crate::app::AppCommand::Config(
                crate::config::Command::Edit(edit),
            ))) = up
            else {
                panic!("double click should save one edit")
            };
            assert!(edit.terminal.memory_diagnostics());
            app.update(crate::config::Event::Updated(
                crate::config::ConfigEditResult {
                    terminal: edit.terminal,
                    status_line: edit.status_line.clone(),
                    choices: crate::config::config_choices(
                        &edit.server_config,
                        &edit.providers,
                        edit.terminal,
                        edit.status_line,
                    ),
                },
            ));
        }
    }
    crate::tui_assert_snapshot!("config_double_click_changes_item", frame_text(&app));
    let Some(crate::app::AppCommand::Config(crate::config::Command::Edit(edit))) =
        app.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::NONE))
    else {
        panic!("reset remains available after double click")
    };
    assert!(!edit.terminal.memory_diagnostics());
}
