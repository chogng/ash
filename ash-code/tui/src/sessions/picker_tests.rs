use super::SessionSelectionAction;
use super::session_choices;
use super::session_choices_at;
use crate::widgets::list_selection::ListSelectionInputOutcome;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionState;
use ash_protocol::Session;
use ash_protocol::SessionId;
use ash_protocol::SessionStatus;
use ash_protocol::SessionThread;
use ash_protocol::ThreadId;
use ash_protocol::ThreadStatus;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;

#[test]
fn resume_picker_selects_the_current_session_and_maps_enter_to_its_id() {
    let sessions = vec![Session {
        session_id: SessionId::new("session-1").unwrap(),
        title: "Current work".into(),
        status: SessionStatus::Active,
        manager: Default::default(),
        threads: Vec::new(),
    }];

    let view = session_choices(&sessions, Some("session-1"));
    let state = ListSelectionState::new(view.model);

    assert_eq!(state.title(), "Resume session");
    assert!(!state.show_tabs());
    assert_eq!(state.visible_items()[0].label(), "Current work");
    assert_eq!(
        view.actions.values().next(),
        Some(&SessionSelectionAction::Resume {
            session_id: "session-1".into(),
        })
    );
    assert!(
        view.actions
            .contains_key(&ListSelectionItemId::new("session:session-1"))
    );
}

#[test]
fn resume_action_ids_do_not_change_when_sessions_are_reordered() {
    let session = |id: &str| Session {
        session_id: SessionId::new(id).unwrap(),
        title: id.into(),
        status: SessionStatus::Active,
        manager: Default::default(),
        threads: Vec::new(),
    };

    let first = session_choices(&[session("session-1"), session("session-2")], None);
    let reordered = session_choices(&[session("session-2"), session("session-1")], None);

    assert_eq!(
        first.actions, reordered.actions,
        "session actions must be keyed by the real session identity"
    );
}

#[test]
fn resume_picker_excludes_archived_sessions_and_keeps_current_selection() {
    let sessions = vec![
        Session {
            session_id: SessionId::new("session-2").unwrap(),
            title: "Archived work".into(),
            status: SessionStatus::Archived,
            manager: Default::default(),
            threads: Vec::new(),
        },
        Session {
            session_id: SessionId::new("session-1").unwrap(),
            title: "Active work".into(),
            status: SessionStatus::Active,
            manager: Default::default(),
            threads: Vec::new(),
        },
        Session {
            session_id: SessionId::new("session-3").unwrap(),
            title: "Other work".into(),
            status: SessionStatus::Active,
            manager: Default::default(),
            threads: Vec::new(),
        },
    ];

    let view = session_choices(&sessions, Some("session-1"));
    let mut state = ListSelectionState::new(view.model);

    assert!(!state.show_tabs());
    assert_eq!(state.visible_items().len(), 2);
    assert_eq!(view.actions.len(), 2);
    assert_eq!(state.selected_item().unwrap().label(), "Active work");
    let ListSelectionInputOutcome::Activate(item_id) =
        state.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("active session selection should produce an activation");
    };
    assert_eq!(
        view.actions.get(&item_id),
        Some(&SessionSelectionAction::Resume {
            session_id: "session-1".into(),
        })
    );
    state.focus_search();
    state.handle_paste("Archived work".into());
    assert!(state.visible_items().is_empty());
}

#[test]
fn resume_items_show_time_and_tokens_without_branches_or_ids() {
    let mut session = Session {
        session_id: SessionId::new("session-sized").unwrap(),
        title: "Sized work".into(),
        status: SessionStatus::Active,
        manager: Default::default(),
        threads: vec![SessionThread {
            thread_id: ThreadId::new("thread-sized").unwrap(),
            title: "main".into(),
            created_at_unix_ms: 1,
            completed_turn_duration_ms: 0,
            active_turn_started_at_unix_ms: None,
            usage: Default::default(),
            parent_thread_id: None,
            forked_from_id: None,
            status: ThreadStatus::Active,
        }],
    };
    session.manager.status_changed_at_unix_ms = 10_000;
    session.threads[0].usage.input_tokens.reported = 1_200;
    session.threads[0].usage.output_tokens.reported = 300;

    let view = session_choices_at(&[session], Some("different"), 70_000);
    let state = ListSelectionState::new(view.model);

    assert_eq!(
        state.visible_items()[0].description(),
        Some("1m ago  ·  1.5K tokens")
    );
    assert!(state.search().is_some());
}

#[test]
fn resume_picker_is_empty_when_every_session_is_archived() {
    let session = Session {
        session_id: SessionId::new("archived").unwrap(),
        title: "Archived work".into(),
        status: SessionStatus::Archived,
        manager: Default::default(),
        threads: Vec::new(),
    };
    let view = session_choices(&[session], Some("archived"));
    let mut state = ListSelectionState::new(view.model);
    assert!(state.visible_items().is_empty());
    assert!(view.actions.is_empty());
    assert_eq!(
        state.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ListSelectionInputOutcome::Consumed
    );
}

#[test]
fn resume_picker_renders_only_session_title_time_and_tokens() {
    use crate::render::test_context;
    use crate::widgets::list_selection::draw_body_with_pointer;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::layout::Rect;

    let now = 1_700_000_000_000;
    let sessions = [0, 60_000, 3_660_000, 90_000_000]
        .into_iter()
        .enumerate()
        .map(|(index, elapsed)| Session {
            session_id: SessionId::new(format!("thread:{index}")).unwrap(),
            title: format!("Conversation {}", index + 1),
            status: SessionStatus::Active,
            manager: ash_protocol::SessionManagerInfo {
                status_changed_at_unix_ms: now - elapsed,
                ..Default::default()
            },
            threads: Vec::new(),
        })
        .collect::<Vec<_>>();
    let view = session_choices_at(&sessions, Some("thread:2"), now);
    let state = ListSelectionState::new(view.model);
    assert!(!state.show_tabs());
    let mut terminal = Terminal::new(TestBackend::new(80, 7)).unwrap();
    terminal
        .draw(|frame| {
            draw_body_with_pointer(
                frame,
                Rect::new(2, 0, 78, 7),
                &state,
                false,
                false,
                None,
                None,
                test_context(),
            );
        })
        .unwrap();
    let buffer = terminal.backend().buffer();
    let text = (0..7)
        .map(|row| {
            (0..80)
                .map(|column| buffer[(column, row)].symbol())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n");
    crate::tui_assert_snapshot!("resume_sessions_compact_metadata", text);
}

#[test]
fn resume_time_floors_elapsed_time_and_omits_zero_trailing_units() {
    let mut session = Session {
        session_id: SessionId::new("session-time").unwrap(),
        title: "Time formatting".into(),
        status: SessionStatus::Active,
        manager: Default::default(),
        threads: Vec::new(),
    };
    let changed_at = 1_700_000_000_000;
    session.manager.status_changed_at_unix_ms = changed_at;

    for (elapsed_ms, expected) in [
        (0, "just now"),
        (59_999, "just now"),
        (60_000, "1m ago"),
        (119_999, "1m ago"),
        (3_599_999, "59m ago"),
        (3_600_000, "1h ago"),
        (3_659_999, "1h ago"),
        (3_660_000, "1h 01m ago"),
        (86_399_999, "23h 59m ago"),
        (86_400_000, "1d ago"),
        (89_999_999, "1d ago"),
        (90_000_000, "1d 1h ago"),
        (604_799_999, "6d 23h ago"),
    ] {
        assert_eq!(
            super::session_time(&session, changed_at + elapsed_ms),
            expected,
            "elapsed milliseconds: {elapsed_ms}"
        );
    }
    assert_eq!(super::session_time(&session, changed_at - 1), "just now");
    session.manager.status_changed_at_unix_ms = 0;
    assert_eq!(super::session_time(&session, changed_at), "time unknown");
}

#[test]
fn resume_time_shows_local_date_starting_at_seven_days() {
    use chrono::TimeZone;

    let changed_at = chrono::Local
        .with_ymd_and_hms(2024, 2, 29, 0, 30, 0)
        .single()
        .unwrap()
        .timestamp_millis() as u64;
    let session = Session {
        session_id: SessionId::new("session-date").unwrap(),
        title: "Older work".into(),
        status: SessionStatus::Archived,
        manager: ash_protocol::SessionManagerInfo {
            status_changed_at_unix_ms: changed_at,
            ..Default::default()
        },
        threads: Vec::new(),
    };
    for elapsed_ms in [604_800_000, 604_800_001, 366 * 86_400_000] {
        assert_eq!(
            super::session_time(&session, changed_at + elapsed_ms),
            "2024-02-29"
        );
    }
}
