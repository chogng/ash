use super::*;
use ash_protocol::SessionManagerInfo;
use ash_protocol::SessionStatus;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::layout::Rect;

#[test]
fn archived_is_a_peer_heading_and_owns_archived_sessions_even_when_pinned() {
    let mut archived = session("old", SessionManagerStatus::Idle, None);
    archived.status = SessionStatus::Archived;
    let sessions = vec![
        session("current", SessionManagerStatus::Idle, None),
        archived,
    ];
    let mut state = SessionManagerState::default();
    state.pinned.insert(SessionId::new("old").unwrap());
    state.reconcile(&sessions);
    state.select_next(&sessions);
    assert!(state.selected_group() == Some(SessionGroup::Archived));
    assert!(state.selected_archive_ids(&sessions).is_empty());
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    for expanded in [false, true] {
        if expanded {
            state.expand_selected_group();
        } else {
            state.collapse_selected_group();
        }
        assert_eq!(
            state.selection_hint().text(),
            if expanded {
                "Enter to collapse · Esc to return"
            } else {
                "Enter to expand · Esc to return"
            }
        );
        terminal
            .draw(|frame| {
                draw_manager(
                    frame,
                    frame.area(),
                    state.view(&sessions),
                    None,
                    None,
                    crate::render::test_context(),
                )
            })
            .unwrap();
        let buffer = terminal.backend().buffer();
        assert_eq!(buffer[(2, 0)].symbol(), "I");
        assert_eq!(buffer[(2, 2)].symbol(), "A");
        let heading = (0..40)
            .map(|column| buffer[(column, 2)].symbol())
            .collect::<String>();
        assert_eq!(heading.trim_end(), "  Archived (1)");
        assert_eq!(buffer[(0, 0)].fg, buffer[(0, 2)].fg);
        assert_eq!(buffer[(0, 0)].modifier, buffer[(0, 2)].modifier);
        let rows = manager_rows(&sessions, &state.pinned, &state.collapsed);
        assert_eq!(rows.len(), if expanded { 4 } else { 3 });
    }
    state.select_next(&sessions);
    assert!(state.selected_is_archived());
    assert!(!state.toggle_selected_pin());
    state.reconcile(&sessions[..1]);
    assert!(state.selected_group() == Some(SessionGroup::Archived));
}

#[test]
fn groups_sessions_by_management_status_and_keeps_pinned_first() {
    let sessions = vec![
        session("completed", SessionManagerStatus::Completed, None),
        session(
            "working",
            SessionManagerStatus::Working,
            Some(SessionManagerActivity::Operation {
                text: "Running tests".into(),
            }),
        ),
        session(
            "question",
            SessionManagerStatus::NeedsInput,
            Some(SessionManagerActivity::Question {
                text: "Which API?".into(),
            }),
        ),
    ];
    let mut state = SessionManagerState::default();
    state.reconcile(&sessions);
    state.selected = Some(SessionManagerPointerTarget::Session(
        SessionId::new("completed").unwrap(),
    ));
    assert!(state.toggle_selected_pin());

    let labels = manager_rows(&sessions, &state.pinned, &state.collapsed)
        .into_iter()
        .map(|row| match row {
            ManagerRow::Heading { group, .. } => group.label().to_owned(),
            ManagerRow::Session(session) => session.session_id.to_string(),
        })
        .collect::<Vec<_>>();

    assert_eq!(
        labels,
        [
            "Pinned",
            "completed",
            "Needs input",
            "question",
            "Working",
            "working",
            "Archived",
        ]
    );
}

#[test]
fn navigation_follows_the_visible_group_order() {
    let sessions = vec![
        session("completed", SessionManagerStatus::Completed, None),
        session("working", SessionManagerStatus::Working, None),
        session("question", SessionManagerStatus::NeedsInput, None),
    ];
    let mut state = SessionManagerState::default();
    state.reconcile(&sessions);

    assert_eq!(state.selected_session().unwrap().as_str(), "question");
    for (group, id) in [
        (SessionGroup::Working, "working"),
        (SessionGroup::Completed, "completed"),
    ] {
        assert!(state.select_next(&sessions));
        assert_eq!(state.selected_group(), Some(group));
        assert!(state.select_next(&sessions));
        assert_eq!(state.selected_session().unwrap().as_str(), id);
    }
}

#[test]
fn row_starts_with_status_icon_and_keeps_name_activity_and_time_columns() {
    let session = session(
        "working",
        SessionManagerStatus::Working,
        Some(SessionManagerActivity::Operation {
            text: "Running targeted tests".into(),
        }),
    );
    let text = line_text(&session_line(
        &session,
        InteractionState::default(),
        0,
        7_210_000,
        72,
        crate::render::test_context(),
    ));

    assert!(text.starts_with("  ⠋ working"));
    assert!(text.contains("Running targeted tests"));
    assert!(text.ends_with("2h"));
    assert_eq!(text.width(), 72);
}

#[test]
fn completed_time_is_relative_but_working_time_is_runtime() {
    let completed = session("done", SessionManagerStatus::Completed, None);
    let working = session("work", SessionManagerStatus::Working, None);

    let context = crate::render::test_context();
    assert_eq!(elapsed_label(&completed, 1_810_000, context), "");
    assert_eq!(elapsed_label(&working, 10_750_000, context), "2h");
    assert_eq!(elapsed_label(&completed, 259_210_000, context), "3d ago");
}

#[test]
fn status_icons_have_distinct_semantics_and_working_animation_advances_on_tick() {
    assert_eq!(status_icon(SessionManagerStatus::Failed, 0), '●');
    assert_eq!(status_icon(SessionManagerStatus::Completed, 0), '●');
    assert_eq!(status_icon(SessionManagerStatus::Stopped, 0), '■');

    let sessions = vec![session("working", SessionManagerStatus::Working, None)];
    let mut state = SessionManagerState::default();
    let started = Instant::now();
    state.refresh_time(started, &sessions);
    let first = state.animation_frame;
    assert!(state.refresh_time(started + ANIMATION_INTERVAL, &sessions));
    assert_ne!(state.animation_frame, first);
}

#[test]
fn summary_column_stays_empty_without_a_configured_summary_result() {
    let session = session("ready", SessionManagerStatus::ReadyForReview, None);

    assert_eq!(activity_text(&session), "");
}

#[test]
fn viewport_reserves_rows_for_both_overflow_notices() {
    assert_eq!(
        manager_viewport(20, Some(10), 5),
        ManagerViewport { start: 8, end: 11 }
    );
}

#[test]
fn every_group_heading_is_selectable_and_collapses_only_its_own_sessions() {
    let sessions = vec![
        session("question", SessionManagerStatus::NeedsInput, None),
        session("working", SessionManagerStatus::Working, None),
        session("review", SessionManagerStatus::ReadyForReview, None),
        session("failed", SessionManagerStatus::Failed, None),
        session("stopped", SessionManagerStatus::Stopped, None),
        session("completed", SessionManagerStatus::Completed, None),
        session("idle", SessionManagerStatus::Idle, None),
        session("pinned", SessionManagerStatus::Idle, None),
        Session {
            status: SessionStatus::Archived,
            ..session("archived", SessionManagerStatus::Idle, None)
        },
    ];
    for group in SessionGroup::ALL {
        let mut state = SessionManagerState::default();
        state.pinned.insert(SessionId::new("pinned").unwrap());
        state.reconcile(&sessions);
        state.navigate(&sessions, crate::widgets::navigation::Navigation::First);
        while state.selected_group() != Some(group) {
            assert!(
                state.select_next(&sessions),
                "heading must be reachable: {group:?}"
            );
        }
        assert!(state.selected_session().is_none());
        assert!(state.selected_archive_ids(&sessions).is_empty());
        assert!(!state.toggle_selected_pin());
        state.expand_selected_group();
        let expanded = manager_rows(&sessions, &state.pinned, &state.collapsed)
            .iter()
            .map(ManagerRow::target)
            .collect::<Vec<_>>();
        state.toggle_selected_group();
        state.reconcile(&sessions);
        assert_eq!(state.selected_group(), Some(group));
        assert_eq!(
            state.selection_hint().text(),
            "Enter to expand · Esc to return"
        );
        let collapsed = manager_rows(&sessions, &state.pinned, &state.collapsed)
            .iter()
            .map(ManagerRow::target)
            .collect::<Vec<_>>();
        let expected = expanded
            .iter()
            .filter(|target| match target {
                SessionManagerPointerTarget::Session(id) => !sessions.iter().any(|session| {
                    &session.session_id == id && group.includes(session, &state.pinned)
                }),
                _ => true,
            })
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(collapsed, expected);
        assert_eq!(expanded.len(), collapsed.len() + 1);
        state.toggle_selected_group();
        assert_eq!(
            state.selection_hint().text(),
            "Enter to collapse · Esc to return"
        );
        assert_eq!(
            manager_rows(&sessions, &state.pinned, &state.collapsed)
                .iter()
                .map(ManagerRow::target)
                .collect::<Vec<_>>(),
            expanded
        );
    }
}

#[test]
fn rendering_shows_group_count_overflow_and_high_contrast_selection() {
    let sessions = (0..8)
        .map(|index| session(&format!("idle-{index}"), SessionManagerStatus::Idle, None))
        .collect::<Vec<_>>();
    let mut state = SessionManagerState::default();
    state.reconcile(&sessions);
    state.focus();
    let backend = TestBackend::new(32, 5);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal
        .draw(|frame| {
            draw_manager(
                frame,
                Rect::new(0, 0, 32, 5),
                state.view(&sessions),
                None,
                None,
                crate::render::test_context(),
            )
        })
        .unwrap();
    let buffer = terminal.backend().buffer();
    let rendered = (0..5)
        .map(|row| {
            (0..32)
                .map(|column| buffer[(column, row)].symbol())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");

    assert!(rendered.contains("Idle (8)"));
    assert!(rendered.contains("more below"));
    let context = crate::render::test_context();
    assert_eq!(buffer[(0, 0)].fg, context.muted());
    assert_eq!(buffer[(0, 1)].symbol(), ">");
    assert_eq!(buffer[(0, 1)].fg, context.selection_foreground());
    assert_eq!(buffer[(0, 1)].bg, context.selection_background());

    for _ in 0..5 {
        state.select_next(&sessions);
    }
    terminal
        .draw(|frame| {
            draw_manager(
                frame,
                Rect::new(0, 0, 32, 5),
                state.view(&sessions),
                None,
                None,
                crate::render::test_context(),
            )
        })
        .unwrap();
    let buffer = terminal.backend().buffer();
    let rendered = (0..5)
        .map(|row| {
            (0..32)
                .map(|column| buffer[(column, row)].symbol())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(rendered.contains("more above"));
    assert!(rendered.contains("more below"));
}

#[test]
fn blurred_manager_keeps_its_cursor_without_rendering_keyboard_selection() {
    let sessions = vec![session("idle", SessionManagerStatus::Idle, None)];
    let mut state = SessionManagerState::default();
    state.reconcile(&sessions);
    let mut terminal = Terminal::new(TestBackend::new(32, 3)).unwrap();

    terminal
        .draw(|frame| {
            draw_manager(
                frame,
                frame.area(),
                state.view(&sessions),
                None,
                None,
                crate::render::test_context(),
            )
        })
        .unwrap();
    assert_eq!(
        terminal.backend().buffer()[(0, 0)].fg,
        crate::render::test_context().muted()
    );

    state.focus();
    terminal
        .draw(|frame| {
            draw_manager(
                frame,
                frame.area(),
                state.view(&sessions),
                None,
                None,
                crate::render::test_context(),
            )
        })
        .unwrap();
    assert_eq!(
        terminal.backend().buffer()[(0, 1)].bg,
        crate::render::test_context().selection_background()
    );
}

#[test]
fn pointer_targets_and_hover_cover_the_complete_visible_session_row() {
    let sessions = vec![session("idle", SessionManagerStatus::Idle, None)];
    let mut state = SessionManagerState::default();
    state.reconcile(&sessions);
    let area = Rect::new(0, 0, 32, 3);
    let target = pointer_target_at(
        area,
        state.view(&sessions),
        ratatui::layout::Position::new(area.right() - 1, 1),
    )
    .unwrap();
    assert_eq!(
        target,
        SessionManagerPointerTarget::Session(SessionId::new("idle").unwrap())
    );
    let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
    terminal
        .draw(|frame| {
            draw_manager(
                frame,
                area,
                state.view(&sessions),
                Some(&target),
                None,
                crate::render::test_context(),
            )
        })
        .unwrap();
    for column in area.x..area.right() {
        assert_eq!(
            terminal.backend().buffer()[(column, 1)].bg,
            crate::render::test_context().hover_background()
        );
    }
    assert!(state.focus_pointer(&sessions, &target));
    assert!(state.focused());
    assert_eq!(state.selected_session().unwrap().as_str(), "idle");
}

fn session(
    id: &str,
    status: SessionManagerStatus,
    activity: Option<SessionManagerActivity>,
) -> Session {
    Session {
        session_id: SessionId::new(id).unwrap(),
        title: id.into(),
        status: SessionStatus::Active,
        manager: SessionManagerInfo {
            status,
            status_changed_at_unix_ms: 10_000,
            activity,
            summary: None,
        },
        threads: Vec::new(),
    }
}

fn line_text(line: &Line<'_>) -> String {
    line.spans
        .iter()
        .map(|span| span.content.to_string())
        .collect()
}
