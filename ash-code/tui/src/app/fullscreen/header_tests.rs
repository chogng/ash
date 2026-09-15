use crate::app::App;
use crate::app::AppCommand;
use ash_app_server_protocol::protocol::git::GitHeadDto;
use ash_app_server_protocol::protocol::git::GitStatusResult;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use ratatui::style::Modifier;

fn app_with_branch() -> App {
    let mut app = App::for_dir(std::path::Path::new("/work/ash"));
    app.update(crate::status::Event::GitStatusReceived(GitStatusResult {
        repository_id: "repository".into(),
        stream_instance_id: ash_protocol::StreamInstanceId::new("git-stream").unwrap(),
        revision: 1,
        path: "/work/ash".into(),
        head: GitHeadDto::Unborn {
            name: "main".into(),
        },
        changes: vec![],
    }));
    app
}

#[test]
fn header_keeps_workspace_visible_outside_the_transcript() {
    let app = App::for_dir(std::path::Path::new("/work/ash"));
    let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
    terminal
        .draw(|frame| crate::app::frame::draw(frame, &app))
        .unwrap();
    let row = terminal.backend().buffer().content[..80]
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(row.starts_with("  /work/ash"));
    assert!(!row.contains("Ash Code"));
}

#[test]
fn header_places_branch_and_path_without_repeating_them_below() {
    let mut app = app_with_branch();
    let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
    terminal
        .draw(|frame| crate::app::frame::draw(frame, &app))
        .unwrap();
    let buffer = terminal.backend().buffer();
    let text = buffer
        .content
        .chunks(80)
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.lines().next().unwrap().starts_with("  main /work/ash"));
    assert_eq!(text.matches("main").count(), 1);
    assert_eq!(text.matches("/work/ash").count(), 1);
    assert_eq!(buffer[(2, 0)].fg, app.render_context().foreground());
    assert!(buffer[(2, 0)].modifier.contains(Modifier::BOLD));
    assert_eq!(buffer[(7, 0)].fg, app.render_context().muted());
    crate::tui_assert_snapshot!("workspace_header_and_hintbar", text);

    let area = Rect::new(0, 0, 80, 20);
    let header = super::super::layout(&app, area).header;
    assert_eq!(
        super::target_at(&app, header, Position::new(2, 0)),
        Some(super::Target::Branch)
    );
    assert_eq!(
        super::target_at(&app, header, Position::new(7, 0)),
        Some(super::Target::Workspace)
    );
    super::super::pointer::activate_pointer_item(&mut app, area, 2, 0);
    assert!(app.command_panel().is_some());
}

#[test]
fn every_header_action_has_its_own_hit_target_and_activation() {
    let area = Rect::new(0, 0, 100, 20);
    let positions = |app: &App| {
        let header = super::super::layout(app, area).header;
        (0..area.width)
            .filter_map(|column| {
                let position = Position::new(column, header.y);
                super::target_at(app, header, position).map(|target| (target, position))
            })
            .fold(std::collections::BTreeMap::new(), |mut positions, pair| {
                positions.entry(pair.0).or_insert(pair.1);
                positions
            })
    };
    let app = app_with_branch();
    let targets = positions(&app);
    for target in [
        super::Target::Branch,
        super::Target::Workspace,
        super::Target::Context,
        super::Target::Dashboard,
    ] {
        assert!(targets.contains_key(&target), "missing {target:?}");
    }

    let activate = |target| {
        let mut app = app_with_branch();
        let position = positions(&app)[&target];
        let command =
            super::super::pointer::activate_pointer_item(&mut app, area, position.x, position.y);
        (app, command)
    };
    assert!(matches!(
        activate(super::Target::Branch).1,
        Some(AppCommand::Git(crate::git::Command::OpenPicker))
    ));
    assert!(matches!(
        activate(super::Target::Workspace).1,
        Some(AppCommand::Projects(crate::projects::Command::OpenRoots))
    ));
    assert!(matches!(
        activate(super::Target::Context).1,
        Some(AppCommand::Status(crate::status::Command::OpenPanel))
    ));
    let (app, command) = activate(super::Target::Dashboard);
    assert!(command.is_none());
    assert!(app.session_manager_view().is_some());
}

#[test]
fn clicking_dashboard_twice_returns_to_the_active_session() {
    let mut app = app_with_branch();
    app.update(crate::thread::Event::ContextChanged {
        session_id: ash_protocol::SessionId::new("current").unwrap(),
        thread_id: ash_protocol::ThreadId::new("current").unwrap(),
    });
    let area = Rect::new(0, 0, 100, 20);
    let header = super::super::layout(&app, area).header;
    let position = (0..area.width)
        .map(|column| Position::new(column, header.y))
        .find(|position| {
            super::target_at(&app, header, *position) == Some(super::Target::Dashboard)
        })
        .unwrap();

    app.fullscreen.focus_header(super::Target::Dashboard);
    assert_eq!(
        super::super::pointer::activate_pointer_item(&mut app, area, position.x, position.y),
        None
    );
    assert!(app.session_manager_view().is_some());
    assert_eq!(app.session_manager_hint().text(), "Esc to return");

    app.fullscreen.focus_header(super::Target::Dashboard);
    assert_eq!(
        super::super::pointer::activate_pointer_item(&mut app, area, position.x, position.y),
        None
    );
    assert!(app.session_manager_view().is_none());
    assert!(app.chat_input_focused());
    assert_eq!(
        app.sessions.active_session_id().unwrap().as_str(),
        "current"
    );
}

#[test]
fn keyboard_focus_reaches_header_and_context_uses_the_existing_progress_bar() {
    use ash_app_server_protocol::protocol::config::ModelRefDto;
    use ash_protocol::ModelContextUsage;
    use ash_protocol::ModelContextUsageSource;
    let mut app = app_with_branch();
    let selected = ModelRefDto {
        provider: "provider".into(),
        model: "model".into(),
    };
    app.chat_panel
        .status_line_mut()
        .apply_context_capacity(Some(&selected), Some(100));
    app.chat_panel.status_line_mut().apply_context_usage(Some((
        ash_protocol::ModelRef::new(
            ash_protocol::ProviderId::new("provider").unwrap(),
            ash_protocol::ModelId::new("model").unwrap(),
        ),
        ModelContextUsage {
            used_tokens: 40,
            source: ModelContextUsageSource::ProviderReported,
        },
    )));

    app.handle_key(KeyEvent::new(KeyCode::F(6), KeyModifiers::NONE));
    assert!(app.fullscreen.header_focused());
    assert_eq!(
        app.fullscreen.header.selected(),
        Some(super::Target::Dashboard)
    );
    app.handle_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
    assert_eq!(
        app.fullscreen.header.selected(),
        Some(super::Target::Context)
    );

    let mut terminal = Terminal::new(TestBackend::new(100, 20)).unwrap();
    terminal
        .draw(|frame| crate::app::frame::draw(frame, &app))
        .unwrap();
    let row = terminal.backend().buffer().content[..100]
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(row.contains("[████░░░░░░ 40%] [Dashboard]"));
    let header = super::super::layout(&app, Rect::new(0, 0, 100, 20)).header;
    let context_position = (0..100)
        .map(|column| Position::new(column, header.y))
        .find(|position| super::target_at(&app, header, *position) == Some(super::Target::Context))
        .unwrap();
    let context_cell = &terminal.backend().buffer()[(context_position.x, context_position.y)];
    assert_eq!(context_cell.bg, app.render_context().background());
    assert!(context_cell.modifier.contains(Modifier::UNDERLINED));
    assert!(matches!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Status(crate::status::Command::OpenPanel))
    ));
}

#[test]
fn header_hovers_never_paint_a_background_or_move_keyboard_selection() {
    let area = Rect::new(0, 0, 100, 20);
    for target in [
        super::Target::Branch,
        super::Target::Workspace,
        super::Target::Context,
        super::Target::Dashboard,
    ] {
        let mut app = app_with_branch();
        let header = super::super::layout(&app, area).header;
        let position = (0..area.width)
            .map(|column| Position::new(column, header.y))
            .find(|position| super::target_at(&app, header, *position) == Some(target))
            .unwrap();
        app.fullscreen
            .pointer
            .update_hover(Some(super::super::pointer::PointerTarget::Header(target)));
        let mut terminal = Terminal::new(TestBackend::new(100, 20)).unwrap();
        terminal
            .draw(|frame| crate::app::frame::draw(frame, &app))
            .unwrap();
        let cell = &terminal.backend().buffer()[(position.x, position.y)];
        if target != super::Target::Context {
            assert_eq!(cell.fg, app.render_context().hover_foreground());
        }
        assert_eq!(cell.bg, app.render_context().background());
        assert_eq!(app.fullscreen.header.selected(), None);
    }
}

#[test]
fn workspace_mutations_are_not_pointer_targets_while_a_turn_is_starting() {
    let mut app = app_with_branch();
    app.insert_text("start work");
    assert!(matches!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(AppCommand::Thread(
            crate::thread::Command::SubmitTurn { .. }
        ))
    ));
    let area = Rect::new(0, 0, 100, 20);
    let header = super::super::layout(&app, area).header;
    let visible = (0..area.width)
        .filter_map(|column| super::target_at(&app, header, Position::new(column, header.y)))
        .collect::<std::collections::BTreeSet<_>>();
    assert!(!visible.contains(&super::Target::Branch));
    assert!(!visible.contains(&super::Target::Workspace));
    assert!(visible.contains(&super::Target::Context));
    assert!(visible.contains(&super::Target::Dashboard));
}

#[test]
fn workspace_path_truncates_with_ellipsis_when_exceeding_width() {
    let long_path = "/Volumes/1t/ash/very/deep/and/extremely/long/nested/directory/path/that/exceeds/terminal/width";
    let app = App::for_dir(std::path::Path::new(long_path));
    let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
    terminal
        .draw(|frame| crate::app::frame::draw(frame, &app))
        .unwrap();
    let row = terminal.backend().buffer().content[..80]
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(row.contains("…"));
    assert!(!row.contains("[+]"));
    let area = Rect::new(0, 0, 80, 20);
    let header = super::super::layout(&app, area).header;
    let workspace_pos = (0..80)
        .map(|col| Position::new(col, header.y))
        .find(|pos| super::target_at(&app, header, *pos) == Some(super::Target::Workspace));
    assert!(workspace_pos.is_some());
}

#[test]
fn dashboard_action_has_depth_contrast_on_hover_and_no_bold_on_press_or_selection() {
    let app = app_with_branch();
    let area = Rect::new(0, 0, 100, 20);
    let header = super::super::layout(&app, area).header;
    let dashboard_pos = (0..area.width)
        .map(|col| Position::new(col, header.y))
        .find(|pos| super::target_at(&app, header, *pos) == Some(super::Target::Dashboard))
        .unwrap();

    let mut terminal = Terminal::new(TestBackend::new(100, 20)).unwrap();
    terminal
        .draw(|frame| crate::app::frame::draw(frame, &app))
        .unwrap();
    let cell = &terminal.backend().buffer()[(dashboard_pos.x, dashboard_pos.y)];
    assert_eq!(cell.fg, app.render_context().muted());
    assert!(!cell.modifier.contains(Modifier::BOLD));

    let mut hovered_app = app_with_branch();
    hovered_app.fullscreen.pointer.update_hover(Some(
        super::super::pointer::PointerTarget::Header(super::Target::Dashboard),
    ));
    terminal
        .draw(|frame| crate::app::frame::draw(frame, &hovered_app))
        .unwrap();
    let hovered_cell = &terminal.backend().buffer()[(dashboard_pos.x, dashboard_pos.y)];
    assert_eq!(hovered_cell.fg, app.render_context().hover_foreground());
    assert_ne!(hovered_cell.fg, app.render_context().muted());
    assert!(!hovered_cell.modifier.contains(Modifier::BOLD));

    let mut pressed_app = app_with_branch();
    pressed_app.fullscreen.pointer.update_pressed(Some(
        super::super::pointer::PointerTarget::Header(super::Target::Dashboard),
    ));
    terminal
        .draw(|frame| crate::app::frame::draw(frame, &pressed_app))
        .unwrap();
    let pressed_cell = &terminal.backend().buffer()[(dashboard_pos.x, dashboard_pos.y)];
    assert_eq!(pressed_cell.fg, app.render_context().pressed_foreground());
    assert!(!pressed_cell.modifier.contains(Modifier::BOLD));

    let mut selected_app = app_with_branch();
    selected_app
        .fullscreen
        .focus_header(super::Target::Dashboard);
    terminal
        .draw(|frame| crate::app::frame::draw(frame, &selected_app))
        .unwrap();
    let selected_cell = &terminal.backend().buffer()[(dashboard_pos.x, dashboard_pos.y)];
    assert_eq!(selected_cell.fg, app.render_context().focus());
    assert!(selected_cell.modifier.contains(Modifier::UNDERLINED));
    assert!(!selected_cell.modifier.contains(Modifier::BOLD));
}
