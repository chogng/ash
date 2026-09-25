use crate::app::App;
use crate::app::AppCommand;
use crate::app::fullscreen::pointer::PointerTarget;
use crate::sessions::Command as SessionCommand;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::style::Modifier;

fn unstarted_app() -> App {
    App::for_dir_with_input_catalog_and_startup_context(
        std::path::Path::new("."),
        crate::thread::composer::ChatInputCatalog::default(),
        crate::TuiStartupContext::new("."),
    )
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn render(app: &App, width: u16, height: u16) -> Buffer {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal
        .draw(|frame| crate::app::frame::draw(frame, app))
        .unwrap();
    terminal.backend().buffer().clone()
}

fn text(buffer: &Buffer) -> String {
    buffer
        .content
        .chunks(usize::from(buffer.area.width))
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

fn worktree(path: &str, current: bool) -> ash_app_server_protocol::protocol::git::GitWorktreeDto {
    ash_app_server_protocol::protocol::git::GitWorktreeDto {
        checkout_root: path.into(),
        path: path.into(),
        branch: Some("main".into()),
        head: "0123456789abcdef0123456789abcdef01234567".into(),
        current,
        state: ash_app_server_protocol::protocol::git::GitWorktreeStateDto::Ready,
    }
}

fn worktree_choices(selected: Option<&str>) -> crate::git::WorktreeChoices {
    crate::git::worktree_choices(
        ash_app_server_protocol::protocol::git::GitWorktreeListResult {
            worktrees: vec![worktree("/repo", true), worktree("/worktrees/topic", false)],
        },
        selected,
    )
}

#[test]
fn home_dashboard_header_opens_the_session_manager() {
    for keyboard in [false, true] {
        let mut app = unstarted_app();
        super::super::navigation::show_manager(&mut app);
        app.open_home();
        assert!(app.fullscreen_home_visible());
        assert!(app.session_manager_view().is_none());

        let command = if keyboard {
            app.handle_key(key(KeyCode::F(6)));
            app.handle_key(key(KeyCode::Enter))
        } else {
            let area = ratatui::layout::Rect::new(0, 0, 80, 24);
            let header = super::super::layout(&app, area).header;
            let position = (0..area.width)
                .map(|column| ratatui::layout::Position::new(column, header.y))
                .find(|position| {
                    super::super::header::target_at(&app, header, *position)
                        == Some(super::super::header::Target::Dashboard)
                })
                .unwrap();
            super::super::pointer::activate_pointer_item(&mut app, area, position.x, position.y)
        };
        assert_eq!(command, None);
        assert!(!app.fullscreen_home_visible());
        assert!(app.session_manager_view().is_some());
        crate::tui_assert_snapshot!(
            "home_dashboard_session_manager",
            text(&render(&app, 80, 24))
        );
    }
}

#[test]
fn home_keeps_actions_above_the_fixed_composer() {
    let mut app = unstarted_app();
    app.open_home();
    assert!(app.fullscreen_home_visible());
    assert!(app.messages().is_empty());
    app.handle_key(key(KeyCode::Tab));
    assert_eq!(app.fullscreen.home.selected, Some(0));
    let terminal = ratatui::layout::Rect::new(0, 0, 140, 30);
    let area = crate::app::fullscreen::layout(&app, terminal);
    let actions = super::layout(area.session.transcript).actions;
    let buffer = render(&app, terminal.width, terminal.height);
    assert_eq!(buffer[(actions.x, actions.y)].symbol(), ">");
    assert_eq!(buffer[(actions.x + 2, actions.y)].symbol(), "N");
    assert!(text(&buffer).contains("New worktree"));
    assert!(!text(&buffer).contains("New branch"));
    assert_eq!(
        buffer[(actions.x, actions.y)].bg,
        app.render_context().selection_background()
    );
    assert!(
        buffer[(actions.x + 2, actions.y)]
            .modifier
            .contains(Modifier::BOLD)
    );
    crate::tui_assert_snapshot!("home_actions", text(&buffer));
    app.handle_key(key(KeyCode::Esc));
    assert_eq!(app.fullscreen.home.selected, None);
    app.insert_text("检查项目结构");
    assert!(app.fullscreen_home_visible());
    assert!(!app.fullscreen_welcome_visible());
    crate::tui_assert_snapshot!(
        "home_draft",
        text(&render(&app, terminal.width, terminal.height))
    );
    assert!(app.messages().is_empty());
}

#[test]
fn home_and_shared_hints_use_the_selected_language() {
    let mut app = unstarted_app();
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_language(crate::nls::Language::Chinese);
    app.update(crate::config::Event::SettingsReceived(settings));
    app.open_home();
    app.handle_key(key(KeyCode::Tab));

    let rendered = text(&render(&app, 80, 24));
    let compact = rendered.replace(' ', "");

    assert!(compact.contains("新建工作树"));
    assert!(!compact.contains("新建分支"));
    assert!(compact.contains("恢复会话"));
    assert!(compact.contains("帮助与快捷键"));
    assert!(compact.contains("Enter选择"));
    assert!(!rendered.contains("Resume session"));
    crate::tui_assert_snapshot!("home_chinese", rendered);

    assert_eq!(
        app.handle_key(key(KeyCode::Enter)),
        Some(AppCommand::Git(crate::git::Command::OpenWorktrees))
    );
    app.update(crate::git::Event::WorktreePickerOpened(worktree_choices(
        None,
    )));
    assert_eq!(app.list_selection().unwrap().title(), "项目工作树");
    assert_eq!(
        app.list_selection()
            .unwrap()
            .search()
            .unwrap()
            .placeholder(),
        "搜索工作树"
    );
    app.handle_key(key(KeyCode::Char('n')));
    assert_eq!(app.list_selection().unwrap().title(), "新建工作树");
    assert_eq!(app.handle_key(key(KeyCode::Esc)), None);
    assert_eq!(app.list_selection().unwrap().title(), "项目工作树");
    assert_eq!(app.handle_key(key(KeyCode::Esc)), None);
}

#[test]
fn home_help_localizes_the_complete_selection_model() {
    let mut app = unstarted_app();
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_language(crate::nls::Language::Chinese);
    app.update(crate::config::Event::SettingsReceived(settings));
    app.open_home();
    app.handle_key(key(KeyCode::Tab));
    for _ in 0..3 {
        app.handle_key(key(KeyCode::Down));
    }

    assert_eq!(app.handle_key(key(KeyCode::Enter)), None);
    let selection = app.list_selection().unwrap();
    assert_eq!(selection.title(), "帮助");
    assert_eq!(
        selection
            .tabs()
            .iter()
            .map(crate::widgets::list_selection::ListSelectionGroup::label)
            .collect::<Vec<_>>(),
        vec!["快捷键", "命令", "自定义命令"]
    );
    assert_eq!(selection.search().unwrap().placeholder(), "搜索帮助");
    crate::tui_assert_snapshot!("help_chinese", text(&render(&app, 90, 24)));
}

#[test]
fn first_character_clears_welcome_and_keeps_the_workspace_header() {
    let mut app = unstarted_app();
    app.open_home();
    assert!(app.fullscreen_welcome_visible());

    app.handle_key(key(KeyCode::Char('x')));

    assert!(app.fullscreen_home_visible());
    assert!(!app.fullscreen_welcome_visible());
    let rendered = text(&render(&app, 80, 24));
    assert!(rendered.lines().next().unwrap().contains("  ."));
    assert!(!rendered.contains("Ash Code v"));
    assert!(!rendered.contains("Resume session"));
    assert!(rendered.contains("> x"));
    crate::tui_assert_snapshot!("home_after_first_character", rendered);

    app.handle_key(key(KeyCode::Backspace));

    assert_eq!(app.input(), "");
    assert!(!app.fullscreen_welcome_visible());

    let mut whitespace = unstarted_app();
    whitespace.open_home();
    whitespace.handle_key(key(KeyCode::Char(' ')));
    assert_eq!(whitespace.input(), " ");
    assert!(!whitespace.fullscreen_welcome_visible());
}

#[test]
fn home_slash_command_starts_a_new_session_from_the_initial_page() {
    let mut app = App::new();
    app.update(crate::thread::Event::ContextChanged {
        session_id: ash_protocol::SessionId::new("existing-session").unwrap(),
        thread_id: ash_protocol::ThreadId::new("existing-thread").unwrap(),
    });
    assert!(!app.fullscreen_home_visible());

    for character in "/home".chars() {
        app.handle_key(key(KeyCode::Char(character)));
    }
    assert_eq!(app.handle_key(key(KeyCode::Enter)), None);

    assert_eq!(app.input(), "");
    assert!(app.fullscreen_home_visible());
    assert!(app.fullscreen_welcome_visible());
    let rendered = text(&render(&app, 80, 24));
    assert!(rendered.lines().next().unwrap().contains("  ."));
    assert!(rendered.contains("Ash Code v"));
    assert!(rendered.contains("Resume session"));
    crate::tui_assert_snapshot!("home_restored_by_slash_command", rendered);

    for character in "start a fresh task".chars() {
        app.handle_key(key(KeyCode::Char(character)));
    }
    let Some(AppCommand::Sessions(SessionCommand::CreateAndEnter { submission })) =
        app.handle_key(key(KeyCode::Enter))
    else {
        panic!("the first task after /home must create a new session");
    };
    assert_eq!(submission.display_text, "start a fresh task");
}

#[test]
fn home_card_uses_the_page_width_without_an_empty_top_band() {
    let mut app = unstarted_app();
    app.open_home();
    let terminal = ratatui::layout::Rect::new(0, 0, 180, 30);
    let transcript = crate::app::fullscreen::layout(&app, terminal)
        .session
        .transcript;
    let card = super::layout(transcript).card;

    assert_eq!(card.x, transcript.x + 2);
    assert_eq!(card.right(), transcript.right() - 2);
    assert_eq!(card.y, transcript.y);
}

#[test]
fn home_worktrees_can_create_and_open_without_starting_a_session() {
    let mut app = unstarted_app();
    app.open_home();
    assert_eq!(app.handle_key(key(KeyCode::Tab)), None);
    assert_eq!(app.fullscreen.home.selected, Some(0));
    assert_eq!(
        app.handle_key(key(KeyCode::Enter)),
        Some(AppCommand::Git(crate::git::Command::OpenWorktrees))
    );
    app.update(crate::git::Event::WorktreePickerOpened(worktree_choices(
        None,
    )));
    assert_eq!(app.list_selection().unwrap().title(), "Project worktrees");
    assert!(app.fullscreen_home_visible());
    crate::tui_assert_snapshot!("home_worktree_picker", text(&render(&app, 80, 24)));
    app.handle_key(key(KeyCode::Char('n')));
    assert_eq!(app.list_selection().unwrap().title(), "New worktree");
    crate::tui_assert_snapshot!("home_new_worktree_prompt", text(&render(&app, 80, 24)));
    for character in "topic".chars() {
        app.handle_key(key(KeyCode::Char(character)));
    }
    assert_eq!(
        app.handle_key(key(KeyCode::Enter)),
        Some(AppCommand::Git(crate::git::Command::CreateWorktree {
            name: "topic".into()
        }))
    );
    assert!(app.fullscreen_home_visible());
    app.update(crate::git::Event::WorktreeCreated {
        path: "/worktrees/topic".into(),
        choices: Ok(worktree_choices(Some("/worktrees/topic"))),
    });
    assert!(app.fullscreen_home_visible());
    assert_eq!(app.list_selection().unwrap().title(), "Project worktrees");
    assert_eq!(
        app.list_selection()
            .unwrap()
            .selected_item()
            .unwrap()
            .label(),
        "topic"
    );
    assert_eq!(
        app.list_selection().unwrap().message(),
        Some("Worktree created. Enter to open it.")
    );
    crate::tui_assert_snapshot!("home_worktree_created", text(&render(&app, 80, 24)));
    assert_eq!(
        app.handle_key(key(KeyCode::Enter)),
        Some(AppCommand::Git(crate::git::Command::ResolveWorktree {
            checkout_root: "/worktrees/topic".into(),
        }))
    );
    app.update(crate::git::Event::WorktreeResolved(Ok(
        "/worktrees/topic".into()
    )));
    assert!(app.command_panel().is_none());
    assert_eq!(app.take_workspace_open(), Some("/worktrees/topic".into()));
    assert!(app.starts_new_session());
    assert!(app.sessions.active_session_id().is_none());
}

#[test]
fn opening_a_worktree_keeps_the_existing_session_bound_to_its_workspace() {
    let mut app = App::new();
    let active_session = app.sessions.active_session_id().cloned();
    let directory = app.welcome().directory().to_owned();
    app.open_home();
    app.update(crate::git::Event::WorktreePickerOpened(worktree_choices(
        None,
    )));
    app.handle_key(key(KeyCode::Down));
    assert_eq!(
        app.handle_key(key(KeyCode::Enter)),
        Some(AppCommand::Git(crate::git::Command::ResolveWorktree {
            checkout_root: "/worktrees/topic".into(),
        }))
    );
    app.update(crate::git::Event::WorktreeResolved(Ok(
        "/worktrees/topic".into()
    )));

    assert_eq!(app.sessions.active_session_id(), active_session.as_ref());
    assert_eq!(app.welcome().directory(), directory);
    assert_eq!(app.take_workspace_open(), Some("/worktrees/topic".into()));
}

#[test]
fn home_pointer_actions_use_the_same_worktree_and_resume_paths() {
    let terminal = ratatui::layout::Rect::new(0, 0, 100, 30);
    let mut app = unstarted_app();
    app.open_home();
    let transcript = crate::app::fullscreen::layout(&app, terminal)
        .session
        .transcript;
    let actions = super::layout(transcript).actions;
    assert_eq!(
        super::action_at(
            &app,
            transcript,
            ratatui::layout::Position::new(actions.x, actions.y),
        ),
        Some(super::Action::Worktrees)
    );
    assert_eq!(
        super::super::pointer::activate_pointer_item(&mut app, terminal, actions.x, actions.y),
        Some(AppCommand::Git(crate::git::Command::OpenWorktrees))
    );
    app.update(crate::git::Event::WorktreePickerOpened(worktree_choices(
        None,
    )));
    assert_eq!(app.list_selection().unwrap().title(), "Project worktrees");

    let mut app = unstarted_app();
    app.open_home();
    assert_eq!(
        super::action_at(
            &app,
            transcript,
            ratatui::layout::Position::new(actions.x, actions.y + 1),
        ),
        Some(super::Action::Resume)
    );
    assert_eq!(
        super::super::pointer::activate_pointer_item(&mut app, terminal, actions.x, actions.y + 1),
        None
    );
    assert_eq!(app.list_selection().unwrap().title(), "Resume session");
}

#[test]
fn home_action_hover_and_press_do_not_change_keyboard_selection() {
    let mut app = unstarted_app();
    app.open_home();
    app.handle_key(key(KeyCode::Tab));
    let terminal = ratatui::layout::Rect::new(0, 0, 100, 30);
    let actions = super::layout(
        crate::app::fullscreen::layout(&app, terminal)
            .session
            .transcript,
    )
    .actions;
    app.fullscreen
        .pointer
        .update_hover(Some(PointerTarget::HomeAction(super::Action::Settings)));

    let hovered = render(&app, terminal.width, terminal.height);
    assert_eq!(app.fullscreen.home.selected, Some(0));
    assert_eq!(hovered[(actions.x, actions.y)].symbol(), ">");
    assert_eq!(
        hovered[(actions.x + 2, actions.y)].bg,
        app.render_context().selection_background()
    );
    assert_eq!(hovered[(actions.x, actions.y + 2)].symbol(), " ");
    assert_eq!(hovered[(actions.x + 2, actions.y + 2)].symbol(), "S");
    for row in 0..actions.height {
        assert!(
            hovered[(actions.x + 2, actions.y + row)]
                .modifier
                .contains(Modifier::BOLD),
            "home action row {row} should be bold"
        );
    }
    for x in actions.x..actions.right() {
        assert_eq!(
            hovered[(x, actions.y + 2)].bg,
            app.render_context().hover_background()
        );
    }
    assert_eq!(
        super::action_at(
            &app,
            crate::app::fullscreen::layout(&app, terminal)
                .session
                .transcript,
            ratatui::layout::Position::new(actions.right() - 1, actions.y + 2),
        ),
        Some(super::Action::Settings)
    );

    app.fullscreen
        .pointer
        .update_pressed(Some(PointerTarget::HomeAction(super::Action::Settings)));
    let pressed = render(&app, terminal.width, terminal.height);
    for x in actions.x..actions.right() {
        assert_eq!(
            pressed[(x, actions.y + 2)].bg,
            app.render_context().pressed_background()
        );
    }
    assert_eq!(app.fullscreen.home.selected, Some(0));
}

#[test]
fn home_submission_failure_restores_the_complete_draft() {
    let mut app = unstarted_app();
    app.open_home();
    let pasted = "长粘贴内容".repeat(300);
    app.handle_paste(pasted.clone());
    let draft = app.input().to_owned();
    let Some(AppCommand::Sessions(SessionCommand::CreateAndEnter { submission })) =
        app.handle_key(key(KeyCode::Enter))
    else {
        panic!("home input must create a conversation");
    };
    assert!(submission.input.iter().any(|item| matches!(item, crate::thread::composer::ChatInputItem::Text(text) if text.contains(&pasted))));
    assert!(app.sessions.pending_submission.is_some());
    assert!(!app.accepts_input());
    assert_eq!(app.handle_key(key(KeyCode::Enter)), None);
    app.fail_session_creation("Could not create session".into());
    assert_eq!(app.input(), draft);
    assert!(app.accepts_input());
    assert!(app.fullscreen_home_visible());
    assert!(!app.fullscreen_welcome_visible());
    crate::tui_assert_snapshot!("home_submission_failed", text(&render(&app, 80, 24)));
}

#[test]
fn home_menu_scrolls_to_every_action_on_short_terminals() {
    let mut app = unstarted_app();
    app.open_home();
    for _ in 0..5 {
        app.handle_key(key(KeyCode::Tab));
    }
    assert_eq!(app.fullscreen.home.selected, Some(4));
    crate::tui_assert_snapshot!("home_narrow", text(&render(&app, 40, 16)));
    assert_eq!(app.handle_key(key(KeyCode::Enter)), Some(AppCommand::Quit));
}

#[test]
fn returning_home_preserves_the_running_task_and_conversation_draft() {
    let mut app = App::new();
    let turn = ash_protocol::TurnId::new("running-turn").unwrap();
    app.set_active_turn(turn.clone());
    app.update(crate::thread::Event::TurnActivityChanged(
        crate::thread::TurnActivity::Working,
    ));
    app.insert_text("next message");
    app.open_home();
    assert_eq!(app.active_turn(), Some(&turn));
    assert!(app.fullscreen_home_visible());
    app.handle_key(key(KeyCode::Esc));
    assert!(!app.fullscreen_home_visible());
    assert_eq!(app.active_turn(), Some(&turn));
    assert_eq!(app.input(), "next message");
}

#[test]
fn short_home_keeps_the_input_and_selected_action_visible() {
    let mut app = unstarted_app();
    app.open_home();
    let terminal = ratatui::layout::Rect::new(0, 0, 40, 12);
    for _ in 0..5 {
        app.handle_key_in_area(key(KeyCode::Tab), terminal);
    }
    let areas = crate::app::fullscreen::layout(&app, terminal);
    assert_eq!(areas.input.height, 3);
    let buffer = render(&app, 40, 12);
    assert!(text(&buffer).contains("> Quit"));
    assert!(text(&buffer).contains("Ash Code"));
    assert!(!text(&buffer).contains("Quit Code"));
    assert_eq!(buffer[(areas.input.x + 2, areas.input.y)].symbol(), "╭");
    crate::tui_assert_snapshot!("home_short", text(&buffer));
}
