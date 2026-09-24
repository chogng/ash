use super::*;
use ratatui::Terminal;
use ratatui::backend::TestBackend;

fn page() -> Page {
    Page {
        repository: Repository {
            host: "github.com".into(),
            owner: "team".into(),
            name: "repo".into(),
        },
        issues: vec![
            Issue {
                labels: Vec::new(),
                assignees: Vec::new(),
                number: 3,
                title: "first".into(),
            },
            Issue {
                labels: Vec::new(),
                assignees: Vec::new(),
                number: 5,
                title: "second".into(),
            },
        ],
        next: None,
        refresh_after_seconds: Some(600),
        fetched_at: 10,
        freshness: "Updated".into(),
        notice: String::new(),
    }
}
fn loaded() -> Manager {
    let mut manager = Manager::default();
    let Command::List { generation, .. } = manager.open().unwrap() else {
        panic!()
    };
    manager.update(Event::Listed {
        generation,
        page: 1,
        result: Ok(page()),
    });
    manager
}
fn key(manager: &mut Manager, code: KeyCode) -> Option<Command> {
    manager.handle_key(KeyEvent::new(code, KeyModifiers::NONE))
}
fn snapshot(manager: &Manager, name: &str, width: u16, height: u16) -> ratatui::buffer::Buffer {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal
        .draw(|frame| {
            manager.draw(
                frame,
                frame.area(),
                None,
                None,
                crate::render::test_context(),
            )
        })
        .unwrap();
    let buffer = terminal.backend().buffer();
    let text = (0..height)
        .map(|y| {
            (0..width)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    crate::tui_assert_snapshot!(name, text);
    buffer.clone()
}

#[test]
fn selected_issues_start_one_session_and_retries_keep_the_command_identity() {
    let mut manager = loaded();
    key(&mut manager, KeyCode::Char(' '));
    key(&mut manager, KeyCode::Down);
    key(&mut manager, KeyCode::Char(' '));
    let command = manager
        .handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL))
        .unwrap();
    let Command::Start {
        generation,
        command_id,
        numbers,
        repository,
    } = command
    else {
        panic!()
    };
    assert_eq!(numbers, [3, 5]);
    assert_eq!(repository.name, "repo");
    assert!(manager.pending_creation);
    assert!(key(&mut manager, KeyCode::Tab).is_none());
    assert_eq!(manager.focus, Focus::List);
    snapshot(&manager, "issue_session_starting", 80, 16);
    manager.finish_start(
        generation,
        Some("Required GitHub Skill is unavailable.".into()),
    );
    snapshot(&manager, "issue_session_start_failed", 80, 16);
    let Command::Start {
        command_id: retry, ..
    } = manager
        .handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL))
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(retry, command_id);
}

#[test]
fn browser_states_keep_selection_and_move_focus_through_tabs_search_and_list() {
    let mut manager = loaded();
    key(&mut manager, KeyCode::Char(' '));
    let Command::List {
        generation, state, ..
    } = key(&mut manager, KeyCode::Tab).unwrap()
    else {
        panic!()
    };
    assert_eq!(state, IssueState::Closed);
    assert_eq!(manager.focus, Focus::Tabs);
    assert!(manager.selected.contains(&3));
    let mut closed = page();
    closed.issues = vec![Issue {
        number: 18,
        title: "Already resolved".into(),
        labels: Vec::new(),
        assignees: Vec::new(),
    }];
    manager.update(Event::Listed {
        generation,
        page: 1,
        result: Ok(closed),
    });
    let tabs = snapshot(&manager, "issue_browser_closed", 80, 16);
    assert_ne!(tabs[(3, 2)].style(), tabs[(11, 2)].style());
    key(&mut manager, KeyCode::Down);
    assert_eq!(manager.focus, Focus::Search);
    assert!(manager.search.input_active());
    key(&mut manager, KeyCode::Down);
    assert_eq!(manager.focus, Focus::List);
    key(&mut manager, KeyCode::Up);
    assert_eq!(manager.focus, Focus::Search);
    key(&mut manager, KeyCode::Up);
    assert_eq!(manager.focus, Focus::Tabs);
}

#[test]
fn issue_browser_uses_the_shared_state_column_and_handles_narrow_terminals() {
    let manager = loaded();
    for (width, height) in [(100, 24), (60, 12), (20, 12)] {
        let buffer = snapshot(
            &manager,
            &format!("issue_browser_{width}x{height}"),
            width,
            height,
        );
        assert_eq!(buffer[(0, 7)].symbol(), ">");
        assert_eq!(buffer[(2, 7)].symbol(), "[");
        assert_eq!(
            buffer[(2, 7)].bg,
            crate::render::test_context().selection_background()
        );
        assert!(
            buffer[(2, 7)]
                .modifier
                .contains(ratatui::style::Modifier::BOLD)
        );
        assert!(
            !buffer[(2, 8)]
                .modifier
                .contains(ratatui::style::Modifier::BOLD)
        );
        assert_eq!(
            buffer[(width - 3, 7)].bg,
            crate::render::test_context().selection_background()
        );
        for y in 2..7 {
            assert_eq!(buffer[(0, y)].symbol(), " ");
            assert_eq!(buffer[(1, y)].symbol(), " ");
        }
    }
    let mut terminal = Terminal::new(TestBackend::new(1, 1)).unwrap();
    terminal
        .draw(|frame| {
            manager.draw(
                frame,
                frame.area(),
                None,
                None,
                crate::render::test_context(),
            )
        })
        .unwrap();
}

#[test]
fn issue_items_tabs_and_search_share_pointer_targeting_and_hover_feedback() {
    let mut manager = loaded();
    let area = ratatui::layout::Rect::new(0, 0, 80, 16);
    let areas = manager.interaction_areas(area);
    let issue = manager
        .pointer_target_at(
            area,
            ratatui::layout::Position::new(areas.list.right() - 1, areas.list.y + 1),
            crate::nls::Language::English,
        )
        .unwrap();
    assert_eq!(issue, PointerTarget::Issue(5));
    assert_eq!(
        manager.pointer_target_at(
            area,
            ratatui::layout::Position::new(areas.search.x, areas.search.y),
            crate::nls::Language::English,
        ),
        Some(PointerTarget::Search)
    );
    assert!(matches!(
        manager.pointer_target_at(
            area,
            ratatui::layout::Position::new(areas.tabs.x + 1, areas.tabs.y),
            crate::nls::Language::English,
        ),
        Some(PointerTarget::Tab(0))
    ));

    let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
    terminal
        .draw(|frame| {
            manager.draw(
                frame,
                area,
                Some(&issue),
                None,
                crate::render::test_context(),
            )
        })
        .unwrap();
    for column in areas.list.x..areas.list.right() {
        assert_eq!(
            terminal.backend().buffer()[(column, areas.list.y + 1)].bg,
            crate::render::test_context().hover_background()
        );
    }
    let Some(Command::Read { number, .. }) = manager.activate_pointer(&issue) else {
        panic!("clicking an issue item must use its ordinary activation path")
    };
    assert_eq!(number, 5);
    assert_eq!(manager.cursor, 1);
}

#[test]
fn closed_browser_ignores_late_results_and_empty_selection_cannot_start() {
    let mut manager = loaded();
    assert!(
        manager
            .handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL))
            .is_none()
    );
    assert!(!manager.pending_creation);
    let Command::List { generation, .. } = key(&mut manager, KeyCode::Char('r')).unwrap() else {
        panic!()
    };
    key(&mut manager, KeyCode::Esc);
    manager.update(Event::Listed {
        generation,
        page: 1,
        result: Err("late result".into()),
    });
    assert!(!manager.open);
    assert!(!manager.busy);
    assert_ne!(manager.status, "late result");
}

#[test]
fn search_submits_remote_queries_and_cancels_edits_without_changing_the_query() {
    let mut manager = loaded();
    key(&mut manager, KeyCode::Char('/'));
    manager.handle_paste("body match".into());
    key(&mut manager, KeyCode::Left);
    key(&mut manager, KeyCode::Right);
    let Command::List {
        query, generation, ..
    } = key(&mut manager, KeyCode::Enter).unwrap()
    else {
        panic!()
    };
    assert_eq!(query, "body match");
    let mut found = page();
    found.issues[0].title = "Different title".into();
    manager.update(Event::Listed {
        generation,
        page: 1,
        result: Ok(found),
    });
    assert_eq!(manager.issues[0].title, "Different title");
    key(&mut manager, KeyCode::Char('/'));
    manager.handle_paste(" changed".into());
    key(&mut manager, KeyCode::Esc);
    assert_eq!(manager.search.query(), "body match");
    assert_eq!(manager.focus, Focus::List);
}

#[test]
fn refresh_is_visible_idle_only_and_failure_preserves_rows_without_polling_storms() {
    let mut manager = loaded();
    let deadline = manager.refresh_at.unwrap();
    key(&mut manager, KeyCode::Char('/'));
    assert!(manager.poll_refresh(deadline).is_none());
    key(&mut manager, KeyCode::Esc);
    manager.detail = Some("details".into());
    assert!(manager.poll_refresh(deadline).is_none());
    manager.detail = None;
    let Command::List {
        generation, mode, ..
    } = manager.poll_refresh(deadline).unwrap()
    else {
        panic!()
    };
    assert_eq!(mode, ListMode::Auto);
    assert!(manager.poll_refresh(deadline).is_none());
    manager.update(Event::Listed {
        generation,
        page: 1,
        result: Err("rate limited".into()),
    });
    assert_eq!(manager.issues.len(), 2);
    assert!(
        manager
            .poll_refresh(deadline + Duration::from_secs(60))
            .is_none()
    );
}

#[test]
fn repeated_action_keys_do_not_toggle_selection_or_switch_tabs() {
    let mut manager = loaded();
    for code in [KeyCode::Tab, KeyCode::Char(' '), KeyCode::Char('d')] {
        assert!(
            manager
                .handle_key(KeyEvent::new_with_kind(
                    code,
                    KeyModifiers::NONE,
                    KeyEventKind::Repeat
                ))
                .is_none()
        );
    }
    assert_eq!(manager.focus, Focus::List);
    assert!(manager.selected.is_empty());
    assert!(!manager.pending_creation);
}
