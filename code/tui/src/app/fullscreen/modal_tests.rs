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
fn project_branch_picker_shows_occupied_branch_and_pure_creation_in_both_modes() {
    use crate::app::AppCommand;
    use crate::git::Command as GitCommand;
    use crate::git::Event;
    use ash_app_server_protocol::protocol::git::{GitBranchDto, GitBranchListResult};

    for (mode, snapshot) in [
        (
            crate::terminal::ScreenMode::Fullscreen,
            "project_branch_picker_fullscreen",
        ),
        (
            crate::terminal::ScreenMode::Inline,
            "project_branch_picker_inline",
        ),
    ] {
        let mut app = crate::app::App::new();
        let mut settings = crate::config::TerminalSettings::default();
        settings.set_screen_mode(mode);
        app.update(crate::config::Event::SettingsReceived(settings));
        app.update(Event::PickerOpened(crate::git::choices(
            GitBranchListResult {
                branches: vec![
                    GitBranchDto {
                        name: "main".into(),
                        object_id: "main".into(),
                        current: true,
                        upstream: None,
                        checked_out_elsewhere: Some(false),
                    },
                    GitBranchDto {
                        name: "topic".into(),
                        object_id: "topic".into(),
                        current: false,
                        upstream: None,
                        checked_out_elsewhere: Some(true),
                    },
                ],
            },
        )));
        crate::tui_assert_snapshot!(snapshot, frame_text(&app));
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(
            app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            None
        );
        assert_eq!(
            app.list_selection().unwrap().message(),
            Some("Branch is checked out in another worktree")
        );
        app.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::NONE));
        assert_eq!(
            app.command_panel().unwrap().parent_title(),
            Some("Project branches")
        );
        assert_eq!(app.list_selection().unwrap().title(), "New branch");
        crate::tui_assert_snapshot!(
            match mode {
                crate::terminal::ScreenMode::Fullscreen => "project_branch_creation_fullscreen",
                crate::terminal::ScreenMode::Inline => "project_branch_creation_inline",
            },
            frame_text(&app)
        );
        for character in "topic".chars() {
            app.handle_key(KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE));
        }
        assert!(
            matches!(app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            Some(AppCommand::Git(GitCommand::Create { name })) if name == "ash/topic")
        );
        app.update(Event::CreateFinished {
            name: "ash/topic".into(),
            result: Err("branch already exists".into()),
        });
        assert_eq!(
            app.list_selection().unwrap().message(),
            Some("branch already exists")
        );
        crate::tui_assert_snapshot!(
            match mode {
                crate::terminal::ScreenMode::Fullscreen =>
                    "project_branch_creation_error_fullscreen",
                crate::terminal::ScreenMode::Inline => "project_branch_creation_error_inline",
            },
            frame_text(&app)
        );
        assert_eq!(
            app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            None
        );
        assert_eq!(app.list_selection().unwrap().title(), "Project branches");
    }
}

#[test]
fn project_branch_delete_confirms_and_restores_the_picker_in_both_modes() {
    use crate::app::AppCommand;
    use crate::git::Command as GitCommand;
    use crate::git::Event;
    use ash_app_server_protocol::protocol::git::{GitBranchDto, GitBranchListResult};

    for (mode, language, confirm_snapshot, deleted_snapshot) in [
        (
            crate::terminal::ScreenMode::Fullscreen,
            crate::nls::Language::English,
            "project_branch_delete_confirmation_fullscreen",
            "project_branch_deleted_fullscreen",
        ),
        (
            crate::terminal::ScreenMode::Inline,
            crate::nls::Language::Chinese,
            "project_branch_delete_confirmation_inline_chinese",
            "project_branch_deleted_inline_chinese",
        ),
    ] {
        let mut app = crate::app::App::new();
        let mut settings = crate::config::TerminalSettings::default();
        settings.set_screen_mode(mode);
        settings.set_language(language);
        app.update(crate::config::Event::SettingsReceived(settings));
        let main = GitBranchDto {
            name: "main".into(),
            object_id: "main".into(),
            current: true,
            upstream: None,
            checked_out_elsewhere: Some(false),
        };
        let topic = GitBranchDto {
            name: "topic".into(),
            object_id: "topic".into(),
            current: false,
            upstream: None,
            checked_out_elsewhere: Some(false),
        };
        app.update(Event::PickerOpened(crate::git::choices(
            GitBranchListResult {
                branches: vec![main.clone(), topic],
            },
        )));
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        app.handle_key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::NONE));
        assert_eq!(
            app.list_selection().unwrap().title(),
            if language == crate::nls::Language::Chinese {
                "删除分支"
            } else {
                "Delete branch"
            }
        );
        crate::tui_assert_snapshot!(confirm_snapshot, frame_text(&app));
        assert_eq!(
            app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            None
        );
        app.handle_key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::NONE));
        assert_eq!(
            app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            Some(AppCommand::Git(GitCommand::DeleteBranch {
                name: "topic".into()
            }))
        );
        app.update(Event::BranchDeleted(Err("branch is unmerged".into())));
        assert_eq!(
            app.list_selection().unwrap().message(),
            Some("branch is unmerged")
        );
        app.update(Event::BranchDeleted(Ok(crate::git::choices(
            GitBranchListResult {
                branches: vec![main],
            },
        ))));
        assert_eq!(app.command_panel().unwrap().parent_title(), None);
        assert_eq!(
            app.list_selection().unwrap().message(),
            Some(crate::nls::localize(language, "Branch deleted.")).as_deref()
        );
        crate::tui_assert_snapshot!(deleted_snapshot, frame_text(&app));
    }
}

#[test]
fn project_worktree_delete_confirms_and_restores_the_picker_in_both_modes() {
    use crate::app::AppCommand;
    use crate::git::Command as GitCommand;
    use crate::git::Event;
    use ash_app_server_protocol::protocol::git::GitWorktreeDto;
    use ash_app_server_protocol::protocol::git::GitWorktreeListResult;
    use ash_app_server_protocol::protocol::git::GitWorktreeStateDto;

    for (mode, language, confirm_snapshot, deleted_snapshot) in [
        (
            crate::terminal::ScreenMode::Fullscreen,
            crate::nls::Language::English,
            "project_worktree_delete_confirmation_fullscreen",
            "project_worktree_deleted_fullscreen",
        ),
        (
            crate::terminal::ScreenMode::Inline,
            crate::nls::Language::Chinese,
            "project_worktree_delete_confirmation_inline_chinese",
            "project_worktree_deleted_inline_chinese",
        ),
    ] {
        let mut app = crate::app::App::new();
        let mut settings = crate::config::TerminalSettings::default();
        settings.set_screen_mode(mode);
        settings.set_language(language);
        app.update(crate::config::Event::SettingsReceived(settings));
        let current = GitWorktreeDto {
            checkout_root: "/repo".into(),
            path: "/repo".into(),
            branch: Some("main".into()),
            head: "0123456789abcdef0123456789abcdef01234567".into(),
            current: true,
            state: GitWorktreeStateDto::Ready,
        };
        let topic = GitWorktreeDto {
            checkout_root: "/worktrees/topic".into(),
            path: "/worktrees/topic".into(),
            branch: None,
            head: current.head.clone(),
            current: false,
            state: GitWorktreeStateDto::Ready,
        };
        app.update(Event::WorktreePickerOpened(crate::git::worktree_choices(
            GitWorktreeListResult {
                worktrees: vec![current.clone(), topic],
            },
            None,
        )));
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        app.handle_key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::NONE));
        assert_eq!(
            app.list_selection().unwrap().title(),
            if language == crate::nls::Language::Chinese {
                "删除工作树"
            } else {
                "Delete worktree"
            }
        );
        crate::tui_assert_snapshot!(confirm_snapshot, frame_text(&app));
        assert_eq!(
            app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            Some(AppCommand::Git(GitCommand::DeleteWorktree {
                checkout_root: "/worktrees/topic".into(),
            }))
        );
        app.update(Event::WorktreeDeleted(Err("worktree has changes".into())));
        assert_eq!(
            app.list_selection().unwrap().message(),
            Some("worktree has changes")
        );
        app.update(Event::WorktreeDeleted(Ok(crate::git::worktree_choices(
            GitWorktreeListResult {
                worktrees: vec![current],
            },
            None,
        ))));
        assert_eq!(app.command_panel().unwrap().parent_title(), None);
        assert_eq!(
            app.list_selection().unwrap().message(),
            Some(crate::nls::localize(language, "Worktree deleted.")).as_deref()
        );
        crate::tui_assert_snapshot!(deleted_snapshot, frame_text(&app));
    }
}

#[test]
fn project_branch_parent_title_returns_to_the_picker() {
    use ash_app_server_protocol::protocol::git::GitBranchListResult;

    let mut app = crate::app::App::new();
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_language(crate::nls::Language::Chinese);
    app.update(crate::config::Event::SettingsReceived(settings));
    app.update(crate::git::Event::PickerOpened(crate::git::choices(
        GitBranchListResult {
            branches: Vec::new(),
        },
    )));
    app.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::NONE));
    assert_eq!(
        app.command_panel()
            .unwrap()
            .navigation_title(app.language()),
        "项目分支 › 新建分支"
    );
    let area = Rect::new(0, 0, 100, 30);
    let layout = super::layout(area);
    let parent = super::target_at(
        &app,
        area,
        ratatui::layout::Position::new(layout.title.x + 2, layout.title.y),
    )
    .unwrap();
    assert_eq!(parent, super::Target::Parent);
    assert_ne!(
        super::target_at(
            &app,
            area,
            ratatui::layout::Position::new(layout.title.x + 10, layout.title.y),
        ),
        Some(super::Target::Parent)
    );
    assert_eq!(
        super::activate(
            &mut app,
            area,
            parent,
            crate::widgets::list_selection::ListSelectionClick::Single,
        ),
        None
    );
    assert_eq!(app.command_panel().unwrap().parent_title(), None);
    assert_eq!(app.list_selection().unwrap().title(), "项目分支");
}

#[test]
fn late_branch_creation_does_not_reopen_a_closed_picker() {
    use crate::git::Event;
    use ash_app_server_protocol::protocol::git::GitBranchListResult;

    let mut app = crate::app::App::new();
    app.update(Event::PickerOpened(crate::git::choices(
        GitBranchListResult {
            branches: Vec::new(),
        },
    )));
    let generation = app.panels().generation();
    app.close_command_panel();
    app.update_for_panel(
        generation,
        Event::CreateFinished {
            name: "ash/topic".into(),
            result: Ok(GitBranchListResult {
                branches: Vec::new(),
            }),
        },
    );
    assert!(app.command_panel().is_none());
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
    assert_eq!(
        app.command_panel().unwrap().body().title(app.language()),
        "Model"
    );
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
    assert_eq!(
        app.command_panel().unwrap().body().title(app.language()),
        "Model"
    );
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
    app.update(Event::Finished {
        command: crate::memories::Command::Scopes,
        result: Ok(Page::Scopes {
            enabled: false,
            scopes: vec![
                ash_app_server_protocol::protocol::memory::MemoryScopeDescriptor {
                    label: "Personal memories".into(),
                    policy: MemoryPolicy::disabled(MemoryScope::Profile),
                },
            ],
            list: crate::memories::Listing {
                scope: MemoryScope::Profile,
                query: String::new(),
                revision: 0,
                entries: Vec::new(),
                cursor: None,
            },
        }),
    });
    assert!(super::allows_backdrop_dismiss(&app));
    let area = Rect::new(0, 0, 100, 30);
    let modal = super::layout(area).surface;
    let outside = (area.x, area.y);
    assert!(!modal.contains(ratatui::layout::Position::new(outside.0, outside.1)));

    // Entering the multi-line editor turns the panel into an editing dialog.
    app.handle_key(KeyEvent::new(KeyCode::Char('n'), KeyModifiers::NONE));
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

    // Esc keeps the draft until the user explicitly discards it.
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_some());
    assert!(!super::allows_backdrop_dismiss(&app));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
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
    assert_eq!(
        super::activate(
            &mut app,
            area,
            tab,
            crate::widgets::list_selection::ListSelectionClick::Single
        ),
        None
    );
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
    app.update(Event::Finished {
        command: crate::memories::Command::Scopes,
        result: Ok(Page::Scopes {
            enabled: false,
            scopes: vec![
                ash_app_server_protocol::protocol::memory::MemoryScopeDescriptor {
                    label: "Personal memories".into(),
                    policy: MemoryPolicy::disabled(MemoryScope::Profile),
                },
            ],
            list: crate::memories::Listing {
                scope: MemoryScope::Profile,
                query: String::new(),
                revision: 0,
                entries: Vec::new(),
                cursor: None,
            },
        }),
    });
    crate::tui_assert_snapshot!("memories_management", frame_text(&app));
    assert_memory_action_columns(&app);
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_screen_mode(crate::terminal::ScreenMode::Inline);
    app.update(crate::config::Event::SettingsReceived(settings.clone()));
    assert_memory_action_columns(&app);
    crate::tui_assert_snapshot!("memories_inline_management", frame_text(&app));
    settings.set_screen_mode(crate::terminal::ScreenMode::Fullscreen);
    app.update(crate::config::Event::SettingsReceived(settings));
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.handle_paste("Fixture decision".into());
    app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    app.handle_paste("Use Rust\n保留  两个空格".into());
    assert_memory_editor_columns(&app);
    crate::tui_assert_snapshot!("memories_multiline_editor", frame_text(&app));
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_screen_mode(crate::terminal::ScreenMode::Inline);
    app.update(crate::config::Event::SettingsReceived(settings.clone()));
    assert_memory_editor_columns(&app);
    crate::tui_assert_snapshot!("memories_inline_editor", frame_text(&app));
    settings.set_screen_mode(crate::terminal::ScreenMode::Fullscreen);
    app.update(crate::config::Event::SettingsReceived(settings));
    let Some(crate::app::AppCommand::Memories(command)) =
        app.handle_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL))
    else {
        panic!("save emits a memory command");
    };
    assert!(
        matches!(&command, crate::memories::Command::Add { title, body, .. } if title == "Fixture decision" && body == "Use Rust\n保留  两个空格")
    );
    app.update(Event::Finished {
        command: command.clone(),
        result: Err(crate::memories::Failure {
            code: None,
            message: "Could not save. Your draft is kept.".into(),
        }),
    });
    crate::tui_assert_snapshot!("memories_failed_draft", frame_text(&app));
    assert_eq!(
        app.handle_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL)),
        Some(crate::app::AppCommand::Memories(command.clone()))
    );
    app.update(Event::Finished {
        command,
        result: Err(crate::memories::Failure {
            code: None,
            message: "Offline".into(),
        }),
    });
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    crate::tui_assert_snapshot!("memories_unsaved_draft", frame_text(&app));
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.command_panel().is_none());
    assert_eq!(app.input(), "background draft");
}

fn assert_memory_action_columns(app: &crate::app::App) {
    let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
    terminal
        .draw(|frame| crate::app::frame::draw(frame, app))
        .unwrap();
    let buffer = terminal.backend().buffer();
    let locate = |text: &str| {
        (0..30)
            .find_map(|y| {
                let row = (0..100)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>();
                row.find(text)
                    .map(|offset| (row[..offset].chars().count() as u16, y))
            })
            .unwrap_or_else(|| panic!("missing {text}"))
    };
    let action = locate("+ New Memory");
    let search = locate("Search this scope");
    assert_eq!(action.0 + 2, search.0);
    assert_eq!(buffer[(action.0 - 2, action.1)].symbol(), ">");
    assert!(buffer[action].modifier.contains(Modifier::BOLD));
}

fn assert_memory_editor_columns(app: &crate::app::App) {
    let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
    terminal
        .draw(|frame| crate::app::frame::draw(frame, app))
        .unwrap();
    let buffer = terminal.backend().buffer();
    let locate = |text: &str| {
        (0..30)
            .find_map(|y| {
                let row = (0..100)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>();
                row.find(text)
                    .map(|offset| (row[..offset].chars().count() as u16, y))
            })
            .unwrap_or_else(|| panic!("missing {text}"))
    };
    let title = locate("Title");
    let body = locate("Content");
    assert_eq!(title.0, locate("Fixture decision").0);
    assert_eq!(title.0, body.0);
    assert_eq!(title.0, locate("Use Rust").0);
    assert_eq!(title.0, locate("Personal memories").0);
    assert_eq!(buffer[(body.0 - 2, body.1)].symbol(), ">");
    assert!(buffer[body].modifier.contains(Modifier::BOLD));
}

#[test]
fn memories_search_and_detail_show_scope_results_and_revision() {
    use crate::memories::{Command, Entry, Event, Listing, Page};
    use memories::{Memory, MemoryId, MemoryPolicy, MemoryScope, MemorySource};
    let mut app = crate::app::App::new();
    app.open_home();
    app.update(Event::Finished {
        command: Command::Scopes,
        result: Ok(Page::Scopes {
            enabled: true,
            scopes: vec![
                ash_app_server_protocol::protocol::memory::MemoryScopeDescriptor {
                    label: "Personal memories".into(),
                    policy: MemoryPolicy::disabled(MemoryScope::Profile),
                },
            ],
            list: Listing {
                scope: MemoryScope::Profile,
                query: String::new(),
                revision: 3,
                entries: Vec::new(),
                cursor: None,
            },
        }),
    });
    app.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));
    app.handle_paste("Rust".into());
    let Some(crate::app::AppCommand::Memories(search)) =
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("search command");
    };
    assert!(matches!(&search, Command::Browse { query, .. } if query == "Rust"));
    app.update(Event::Finished {
        command: search,
        result: Ok(Page::List(Listing {
            scope: MemoryScope::Profile,
            query: "Rust".into(),
            revision: 3,
            entries: (0..3)
                .map(|i| Entry {
                    id: MemoryId::new(format!("decision-{i}")).unwrap(),
                    title: format!("Rust decision {i}"),
                    source: MemorySource::User,
                    updated: 1_700_000_000_000,
                    excerpt: "Keep shared behavior in Rust".into(),
                })
                .collect(),
            cursor: Some("next-page".into()),
        })),
    });
    crate::tui_assert_snapshot!("memories_search_results", frame_text(&app));
    let Some(crate::app::AppCommand::Memories(read)) =
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("read command");
    };
    assert!(matches!(&read, Command::Read { id, .. } if id.as_str() == "decision-0"));
    app.update(Event::Finished {
        command: read,
        result: Ok(Page::Read(Memory {
            memory_id: MemoryId::new("decision-0").unwrap(),
            scope: MemoryScope::Profile,
            revision: 3,
            title: "Rust decision 0".into(),
            body: "Keep shared behavior in Rust.\n\nUse the App Server contract from every client."
                .into(),
            source: MemorySource::User,
            created_at_unix_ms: 1_700_000_000_000,
            updated_at_unix_ms: 1_700_000_000_000,
        })),
    });
    crate::tui_assert_snapshot!("memories_detail", frame_text(&app));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    let Some(crate::app::command_panel::CommandPanel::Memories(panel)) = app.command_panel() else {
        panic!("memory list remains open");
    };
    assert_eq!(panel.title(), "Memories");
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
    super::activate(
        &mut app,
        area,
        target.unwrap(),
        crate::widgets::list_selection::ListSelectionClick::Single,
    );
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
fn config_switches_keep_the_selected_language_after_saving() {
    use crate::app::AppCommand;
    use crate::config::Command;
    use crate::config::ConfigEditResult;
    use crate::config::Event;
    use crate::nls::Language;
    use crate::widgets::list_selection::ListSelectionItemId;

    for (language, on, off) in [
        (Language::Chinese, "开启", "关闭"),
        (Language::Japanese, "オン", "オフ"),
        (Language::French, "activé", "désactivé"),
        (Language::English, "on", "off"),
    ] {
        let mut terminal = crate::config::TerminalSettings::default();
        terminal.set_language(language);
        let mut config = crate::test_support::empty_config_snapshot();
        config.features =
            features::resolve(&[(features::Feature::Memories, false)].into_iter().collect());
        let providers = ash_app_server_protocol::protocol::provider::ProviderListResult {
            providers: Vec::new(),
        };
        let mut app = crate::app::App::new();
        app.open_home();
        app.update(Event::SettingsReceived(terminal));
        app.update(Event::EditorOpened(crate::config::config_choices(
            &config,
            &providers,
            terminal,
            crate::status::StatusLineSettings::default(),
        )));
        for (id, steps) in [
            ("terminal-vim-mode", 0),
            ("memory-diagnostics", 1),
            ("show-git-changes-as-diff", 2),
            ("memories", 5),
        ] {
            for _ in 0..steps {
                app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
            }
            assert_eq!(
                app.list_selection().unwrap().selected_item().unwrap().id(),
                Some(&ListSelectionItemId::new(id))
            );
            let label = app
                .list_selection()
                .unwrap()
                .selected_item()
                .unwrap()
                .label()
                .replace(' ', "");
            let body = super::body_area(
                app.command_panel().unwrap(),
                super::layout(Rect::new(0, 0, 100, 30)).content,
            );
            let row_index = usize::from(body.y + crate::widgets::search_box::SEARCH_BOX_HEIGHT)
                + app
                    .list_selection()
                    .unwrap()
                    .selected_visible_index()
                    .unwrap();
            // Wide characters leave continuation cells in the text buffer.
            let switch_row = |frame: &str| frame.lines().nth(row_index).unwrap().replace(' ', "");
            let before = frame_text(&app);
            assert!(
                switch_row(&before)
                    .trim_end_matches('│')
                    .ends_with(&format!("{label}{off}"))
            );
            for enabled in [true, false] {
                let Some(AppCommand::Config(command)) =
                    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
                else {
                    panic!("switch should emit a config command")
                };
                let mut edit = match command {
                    Command::SetMemories(edit) if id == "memories" => edit,
                    Command::Edit(edit) if id != "memories" => edit,
                    other => panic!("unexpected switch command: {other:?}"),
                };
                let actual = match id {
                    "terminal-vim-mode" => {
                        edit.terminal.input_mode() == crate::thread::composer::ChatInputMode::Vim
                    }
                    "memory-diagnostics" => edit.terminal.memory_diagnostics(),
                    "show-git-changes-as-diff" => edit.status_line.show_git_changes_as_diff(),
                    "memories" => {
                        edit.server_config
                            .features
                            .iter()
                            .find(|state| state.feature == features::Feature::Memories)
                            .unwrap()
                            .enabled
                    }
                    _ => unreachable!(),
                };
                assert_eq!(actual, enabled);
                assert_eq!(edit.terminal.language(), language);
                edit.server_config.revision += 1;
                app.update(Event::Updated(ConfigEditResult {
                    terminal: edit.terminal,
                    status_line: edit.status_line.clone(),
                    choices: crate::config::config_choices(
                        &edit.server_config,
                        &edit.providers,
                        edit.terminal,
                        edit.status_line,
                    ),
                }));
                assert_eq!(app.language(), language);
                let frame = frame_text(&app);
                let row = switch_row(&frame);
                assert!(
                    row.trim_end_matches('│')
                        .ends_with(&format!("{label}{}", if enabled { on } else { off })),
                    "{language:?} {id}: {row}"
                );
                if !enabled {
                    assert_eq!(frame, before);
                }
                if language == Language::Chinese && id == "memories" {
                    crate::tui_assert_snapshot!(
                        if enabled {
                            "config_chinese_switch_on"
                        } else {
                            "config_chinese_switch_off"
                        },
                        frame
                    );
                }
            }
        }
    }
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

#[test]
fn config_drag_and_keyboard_input_cancel_pending_double_click() {
    use crate::app::fullscreen::pointer::MouseAction;
    let mut app = crate::app::App::new();
    app.open_home();
    app.update(crate::config::Event::EditorOpened(config_choices()));
    let area = Rect::new(0, 0, 100, 30);
    let body = super::body_area(app.command_panel().unwrap(), super::layout(area).content);
    let event = |kind| MouseEvent {
        kind,
        column: body.x + 8,
        row: body.y + crate::widgets::search_box::SEARCH_BOX_HEIGHT + 1,
        modifiers: KeyModifiers::NONE,
    };
    let click = |app: &mut crate::app::App| {
        crate::app::fullscreen::pointer::handle_mouse(
            app,
            area,
            event(MouseEventKind::Down(MouseButton::Left)),
        );
        crate::app::fullscreen::pointer::handle_mouse(
            app,
            area,
            event(MouseEventKind::Up(MouseButton::Left)),
        )
    };
    assert!(matches!(click(&mut app), MouseAction::Command(None)));
    for kind in [
        MouseEventKind::Down(MouseButton::Left),
        MouseEventKind::Drag(MouseButton::Left),
        MouseEventKind::Up(MouseButton::Left),
    ] {
        assert!(matches!(
            crate::app::fullscreen::pointer::handle_mouse(&mut app, area, event(kind)),
            MouseAction::Selection(None)
        ));
    }
    assert!(matches!(click(&mut app), MouseAction::Command(None)));
    app.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::NONE));
    assert!(matches!(click(&mut app), MouseAction::Command(None)));
    assert!(
        matches!(click(&mut app), MouseAction::Command(Some(crate::app::AppCommand::Config(crate::config::Command::Edit(edit)))) if edit.terminal.memory_diagnostics())
    );
}
