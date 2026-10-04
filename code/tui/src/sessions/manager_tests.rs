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
                "Enter to collapse · g to group · Esc to return"
            } else {
                "Enter to expand · g to group · Esc to return"
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
        assert_eq!(buffer[(2, 2)].symbol(), "I");
        assert_eq!(buffer[(2, 5)].symbol(), "A");
        let heading = (0..40)
            .map(|column| buffer[(column, 5)].symbol())
            .collect::<String>();
        assert_eq!(
            heading.trim_end(),
            if expanded {
                "  Archived (1) -"
            } else {
                "  Archived (1) +"
            }
        );
        assert_eq!(buffer[(0, 2)].fg, buffer[(0, 5)].fg);
        assert_eq!(buffer[(0, 2)].modifier, buffer[(0, 5)].modifier);
        let rows = manager_rows(&sessions, &state.pinned, &state.collapsed, state.grouping);
        assert_eq!(rows.len(), if expanded { 5 } else { 4 });
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

    let labels = manager_rows(&sessions, &state.pinned, &state.collapsed, state.grouping)
        .into_iter()
        .filter_map(|row| match row {
            ManagerRow::Heading { group, .. } => Some(group.label().into_owned()),
            ManagerRow::Session(session) => Some(session.session_id.to_string()),
            ManagerRow::Gap => None,
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
        assert_eq!(state.selected_group(), Some(group.clone()));
        assert!(state.select_next(&sessions));
        assert_eq!(state.selected_session().unwrap().as_str(), id);
    }
}

#[test]
fn group_spacing_disclosure_and_heading_styles_follow_rendered_rows() {
    let sessions = vec![
        session("failed", SessionManagerStatus::Failed, None),
        session("idle", SessionManagerStatus::Idle, None),
    ];
    let mut state = SessionManagerState {
        now_unix_ms: 10_000,
        ..SessionManagerState::default()
    };
    state.reconcile(&sessions);
    let context = crate::render::test_context();
    let area = Rect::new(0, 0, 60, 14);
    let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
    let mut frames = Vec::new();
    for collapsed in [false, true] {
        if collapsed {
            state.focus_pointer(
                &sessions,
                &SessionManagerPointerTarget::Group(SessionGroup::Idle),
            );
            state.collapse_selected_group();
            state.blur();
        }
        terminal
            .draw(|frame| draw_manager(frame, area, state.view(&sessions), None, None, context))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let row_text = |row| {
            (0..area.width)
                .map(|x| buffer[(x, row)].symbol())
                .collect::<String>()
        };
        assert_eq!(row_text(2).trim_end(), "  Failed (1) -");
        assert_eq!(
            row_text(5).trim_end(),
            if collapsed {
                "  Idle (1) +"
            } else {
                "  Idle (1) -"
            }
        );
        let archived_y = if collapsed { 7 } else { 8 };
        assert_eq!(row_text(archived_y).trim_end(), "  Archived (0)");
        for y in [4, archived_y - 1] {
            assert_eq!(row_text(y).trim(), "");
            for x in [0, 2, area.width - 1] {
                assert_eq!(
                    pointer_target_at(
                        area,
                        state.view(&sessions),
                        ratatui::layout::Position::new(x, y)
                    ),
                    None
                );
            }
        }
        assert_eq!(buffer[(2, 2)].fg, context.foreground());
        assert!(buffer[(2, 2)].modifier.contains(Modifier::BOLD));
        assert_eq!(buffer[(9, 2)].fg, context.muted());
        assert!(!buffer[(9, 2)].modifier.contains(Modifier::BOLD));
        frames.push(
            (0..area.height)
                .map(row_text)
                .collect::<Vec<_>>()
                .join("\n"),
        );
        let failed = SessionManagerPointerTarget::Session(sessions[0].session_id.clone());
        state.focus_pointer(&sessions, &failed);
        assert!(state.select_next(&sessions));
        assert_eq!(state.selected_group(), Some(SessionGroup::Idle));
        state.navigate(&sessions, crate::widgets::navigation::Navigation::Previous);
        assert_eq!(state.selected.as_ref(), Some(&failed));
        state.blur();
    }
    crate::tui_assert_snapshot!(
        "dashboard_group_spacing_and_disclosure",
        frames.join("\n\n")
    );
}

#[test]
fn session_title_colors_survive_rename_reorder_grouping_and_new_manager_state() {
    use crate::render::{RenderTheme, ThemePalette};
    use ash_terminal_detection::ColorLevel;
    let sessions = vec![
        session("session-a", SessionManagerStatus::Idle, None),
        session("session-b", SessionManagerStatus::Failed, None),
        session("session-c", SessionManagerStatus::Working, None),
    ];
    let mut renamed = sessions.clone();
    renamed[0].title = "Renamed conversation".into();
    renamed.reverse();
    for palette in [
        ThemePalette::dark(),
        ThemePalette::light(),
        ThemePalette::colorblind_dark(),
        ThemePalette::colorblind_light(),
    ] {
        for level in [
            ColorLevel::TrueColor,
            ColorLevel::Ansi256,
            ColorLevel::Ansi16,
            ColorLevel::Monochrome,
        ] {
            let theme = RenderTheme::from_palette(palette, level);
            let context = RenderContext::new(&theme, 0);
            // These rendered colors also pin the stable identity assignment across releases.
            let expected = [context.keyword(), context.function(), context.variable()];
            for sessions_in_order in [&sessions, &renamed] {
                for grouping in [
                    SessionGrouping::Status,
                    SessionGrouping::Model,
                    SessionGrouping::Project,
                ] {
                    let mut state = SessionManagerState::default();
                    state.set_grouping(grouping, sessions_in_order);
                    state.reconcile(sessions_in_order);
                    for width in [60, 120] {
                        let area = Rect::new(0, 0, width, 24);
                        let mut terminal =
                            Terminal::new(TestBackend::new(width, area.height)).unwrap();
                        terminal
                            .draw(|frame| {
                                draw_manager(
                                    frame,
                                    area,
                                    state.view(sessions_in_order),
                                    None,
                                    None,
                                    context,
                                )
                            })
                            .unwrap();
                        let buffer = terminal.backend().buffer();
                        for (index, session) in sessions.iter().enumerate() {
                            let target =
                                SessionManagerPointerTarget::Session(session.session_id.clone());
                            let row = (0..area.height)
                                .find(|y| {
                                    pointer_target_at(
                                        area,
                                        state.view(sessions_in_order),
                                        ratatui::layout::Position::new(4, *y),
                                    ) == Some(target.clone())
                                })
                                .unwrap();
                            assert_eq!(buffer[(4, row)].fg, expected[index]);
                            assert_eq!(buffer[(2, row)].fg, context.muted());
                        }
                        let layout = manager_layout(area);
                        if !layout.details.is_empty() {
                            let index = sessions
                                .iter()
                                .position(|session| {
                                    Some(&session.session_id) == state.selected_session()
                                })
                                .unwrap();
                            assert_eq!(
                                buffer[(layout.details.x, layout.details.y + 2)].fg,
                                expected[index]
                            );
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn session_identity_colors_yield_to_selected_hovered_and_pressed_styles() {
    use crate::render::{RenderTheme, ThemePalette};
    use ash_terminal_detection::ColorLevel;
    let sessions = vec![session("session-a", SessionManagerStatus::Idle, None)];
    let target = SessionManagerPointerTarget::Session(sessions[0].session_id.clone());
    for level in [ColorLevel::TrueColor, ColorLevel::Monochrome] {
        let theme = RenderTheme::from_palette(ThemePalette::dark(), level);
        let context = RenderContext::new(&theme, 0);
        for width in [60, 120] {
            for (focused, hovered, pressed, fg, bg) in [
                (
                    true,
                    None,
                    None,
                    context.selection_foreground(),
                    context.selection_background(),
                ),
                (
                    false,
                    Some(&target),
                    None,
                    context.hover_foreground(),
                    context.hover_background(),
                ),
                (
                    true,
                    Some(&target),
                    Some(&target),
                    context.pressed_foreground(),
                    context.pressed_background(),
                ),
            ] {
                let mut state = SessionManagerState::default();
                state.reconcile(&sessions);
                if focused {
                    state.focus();
                }
                let area = Rect::new(0, 0, width, 12);
                let mut terminal = Terminal::new(TestBackend::new(width, area.height)).unwrap();
                terminal
                    .draw(|frame| {
                        draw_manager(
                            frame,
                            area,
                            state.view(&sessions),
                            hovered,
                            pressed,
                            context,
                        )
                    })
                    .unwrap();
                let buffer = terminal.backend().buffer();
                let row = manager_layout(area).list.y + 1;
                assert_eq!(buffer[(4, row)].fg, fg);
                assert_eq!(buffer[(4, row)].bg, bg);
                if level == ColorLevel::Monochrome {
                    assert!(buffer[(4, row)].modifier.contains(if focused {
                        Modifier::REVERSED
                    } else {
                        Modifier::UNDERLINED
                    }));
                }
            }
        }
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
            model: None,
            status: SessionStatus::Archived,
            ..session("archived", SessionManagerStatus::Idle, None)
        },
    ];
    for group in SessionGroup::ALL {
        let mut state = SessionManagerState::default();
        state.pinned.insert(SessionId::new("pinned").unwrap());
        state.reconcile(&sessions);
        state.navigate(&sessions, crate::widgets::navigation::Navigation::First);
        while state.selected_group() != Some(group.clone()) {
            assert!(
                state.select_next(&sessions),
                "heading must be reachable: {group:?}"
            );
        }
        assert!(state.selected_session().is_none());
        assert!(state.selected_archive_ids(&sessions).is_empty());
        assert!(!state.toggle_selected_pin());
        state.expand_selected_group();
        let expanded = manager_rows(&sessions, &state.pinned, &state.collapsed, state.grouping)
            .iter()
            .filter_map(ManagerRow::target)
            .collect::<Vec<_>>();
        state.toggle_selected_group();
        state.reconcile(&sessions);
        assert_eq!(state.selected_group(), Some(group.clone()));
        assert_eq!(
            state.selection_hint().text(),
            "Enter to expand · g to group · Esc to return"
        );
        let collapsed = manager_rows(&sessions, &state.pinned, &state.collapsed, state.grouping)
            .iter()
            .filter_map(ManagerRow::target)
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
            "Enter to collapse · g to group · Esc to return"
        );
        assert_eq!(
            manager_rows(&sessions, &state.pinned, &state.collapsed, state.grouping)
                .iter()
                .filter_map(ManagerRow::target)
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
    let backend = TestBackend::new(32, 6);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal
        .draw(|frame| {
            draw_manager(
                frame,
                Rect::new(0, 0, 32, 6),
                state.view(&sessions),
                None,
                None,
                crate::render::test_context(),
            )
        })
        .unwrap();
    let buffer = terminal.backend().buffer();
    let rendered = (0..6)
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
    assert_eq!(buffer[(0, 2)].fg, context.muted());
    assert_eq!(buffer[(0, 3)].symbol(), ">");
    assert_eq!(buffer[(0, 3)].fg, context.selection_foreground());
    assert_eq!(buffer[(0, 3)].bg, context.selection_background());

    for _ in 0..5 {
        state.select_next(&sessions);
    }
    terminal
        .draw(|frame| {
            draw_manager(
                frame,
                Rect::new(0, 0, 32, 6),
                state.view(&sessions),
                None,
                None,
                crate::render::test_context(),
            )
        })
        .unwrap();
    let buffer = terminal.backend().buffer();
    let rendered = (0..6)
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
    let mut terminal = Terminal::new(TestBackend::new(32, 4)).unwrap();

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
        terminal.backend().buffer()[(0, 2)].fg,
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
        terminal.backend().buffer()[(0, 3)].bg,
        crate::render::test_context().selection_background()
    );
}

#[test]
fn pointer_targets_and_hover_cover_the_complete_visible_session_row() {
    let sessions = vec![session("idle", SessionManagerStatus::Idle, None)];
    let mut state = SessionManagerState::default();
    state.reconcile(&sessions);
    let area = Rect::new(0, 0, 32, 4);
    let target = pointer_target_at(
        area,
        state.view(&sessions),
        ratatui::layout::Position::new(area.right() - 1, 3),
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
            terminal.backend().buffer()[(column, 3)].bg,
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
        model: None,
        session_id: SessionId::new(id).unwrap(),
        title: id.into(),
        status: SessionStatus::Active,
        execution_target: None,
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

#[test]
fn dashboard_project_and_model_groups_preserve_session_identity_and_pointer_rows() {
    let mut local = session("local", SessionManagerStatus::Working, None);
    local.execution_target = Some(ash_protocol::SessionExecutionTarget::Local {
        root: "/workspace/shared".into(),
    });
    local.model = Some(ash_protocol::ModelRef::new(
        ash_protocol::ProviderId::new("one").unwrap(),
        ash_protocol::ModelId::new("model").unwrap(),
    ));
    let mut remote = session("remote", SessionManagerStatus::Idle, None);
    remote.execution_target = Some(ash_protocol::SessionExecutionTarget::Ssh {
        host: "server".into(),
        root: "/workspace/shared".into(),
    });
    remote.model = Some(ash_protocol::ModelRef::new(
        ash_protocol::ProviderId::new("two").unwrap(),
        ash_protocol::ModelId::new("model").unwrap(),
    ));
    let mut pinned = session("pinned", SessionManagerStatus::Completed, None);
    pinned.model = local.model.clone();
    let mut archived = session("archived", SessionManagerStatus::Idle, None);
    archived.status = SessionStatus::Archived;
    let sessions = vec![local, remote, pinned, archived];
    let mut state = SessionManagerState::default();
    state.pinned.insert(SessionId::new("pinned").unwrap());
    state.reconcile(&sessions);
    state.focus_pointer(
        &sessions,
        &SessionManagerPointerTarget::Session(SessionId::new("remote").unwrap()),
    );
    for grouping in [SessionGrouping::Project, SessionGrouping::Model] {
        state.set_grouping(grouping, &sessions);
        assert_eq!(
            state.selected_session(),
            Some(&SessionId::new("remote").unwrap())
        );
        let rows = manager_rows(&sessions, &state.pinned, &state.collapsed, grouping);
        let labels = rows
            .iter()
            .filter_map(|row| match row {
                ManagerRow::Heading { group, .. } => Some(group.label().into_owned()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            labels,
            match grouping {
                SessionGrouping::Project => vec![
                    "Pinned",
                    "/workspace/shared",
                    "server:/workspace/shared",
                    "Archived"
                ],
                SessionGrouping::Model => vec!["Pinned", "one/model", "two/model", "Archived"],
                SessionGrouping::Status => unreachable!(),
            }
        );
        let area = Rect::new(0, 0, 70, 18);
        assert_eq!(
            pointer_target_at(
                area,
                state.view(&sessions),
                ratatui::layout::Position::new(5, 0)
            ),
            None
        );
        for (index, row) in rows.iter().enumerate() {
            assert_eq!(
                pointer_target_at(
                    area,
                    state.view(&sessions),
                    ratatui::layout::Position::new(5, index as u16 + 2)
                ),
                row.target()
            );
        }
    }
    state.collapsed.remove(&SessionGroup::Archived);
    let archived = SessionManagerPointerTarget::Session(SessionId::new("archived").unwrap());
    assert!(state.focus_pointer(&sessions, &archived));
    for grouping in [
        SessionGrouping::Status,
        SessionGrouping::Project,
        SessionGrouping::Model,
    ] {
        state.set_grouping(grouping, &sessions);
        assert_eq!(state.selected.as_ref(), Some(&archived));
        assert!(state.selected_is_archived());
        assert!(!state.collapsed.contains(&SessionGroup::Archived));
    }
}

#[test]
fn dashboard_columns_share_pointer_boundaries_and_preserve_focus_colors() {
    let sessions = vec![session("selected", SessionManagerStatus::Working, None)];
    let mut state = SessionManagerState::default();
    state.reconcile(&sessions);
    state.focus();
    for (width, height) in [(120, 18), (60, 10), (120, 3), (20, 4)] {
        let area = Rect::new(0, 0, width, height);
        let layout = manager_layout(area);
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| {
                draw_manager(
                    frame,
                    area,
                    state.view(&sessions),
                    None,
                    None,
                    crate::render::test_context(),
                )
            })
            .unwrap();
        let selected_y = layout.list.y + u16::from(layout.list.height > 1);
        let buffer = terminal.backend().buffer();
        let context = crate::render::test_context();
        assert_eq!(buffer[(0, 0)].symbol(), "─");
        assert_eq!(buffer[(0, 0)].fg, context.muted());
        assert!(!buffer[(0, 0)].modifier.contains(Modifier::BOLD));
        assert_eq!(buffer[(2, 0)].symbol(), "D");
        assert_eq!(buffer[(2, 0)].fg, context.foreground());
        assert!(buffer[(2, 0)].modifier.contains(Modifier::BOLD));
        assert!((0..width).all(|column| buffer[(column, 1)].symbol() == " "));
        if width >= 60 {
            let shortcut = &buffer[(width - 3, 0)];
            assert_eq!(shortcut.symbol(), "g");
            assert_eq!(shortcut.fg, context.action_foreground());
            assert!(shortcut.modifier.contains(Modifier::BOLD));
            let group = (0..width)
                .find(|column| buffer[(*column, 0)].symbol() == "G")
                .unwrap();
            assert_eq!(buffer[(group, 0)].fg, context.muted());
            assert!(!buffer[(group, 0)].modifier.contains(Modifier::BOLD));
        } else {
            assert!(!(0..width).any(|column| buffer[(column, 0)].symbol() == "g"));
        }
        let marker = &buffer[(0, selected_y)];
        assert_eq!(marker.symbol(), ">");
        assert_eq!(
            marker.bg,
            crate::render::test_context().selection_background()
        );
        assert!(marker.modifier.contains(Modifier::BOLD));
        assert_eq!(
            pointer_target_at(
                area,
                state.view(&sessions),
                ratatui::layout::Position::new(0, selected_y)
            ),
            Some(SessionManagerPointerTarget::Session(
                sessions[0].session_id.clone()
            ))
        );
        assert_eq!(
            pointer_target_at(
                area,
                state.view(&sessions),
                ratatui::layout::Position::new(2, layout.header.y)
            ),
            None
        );
        assert_eq!(
            pointer_target_at(
                area,
                state.view(&sessions),
                ratatui::layout::Position::new(2, layout.header.bottom())
            ),
            None
        );
        if !layout.details.is_empty() {
            assert_eq!(
                pointer_target_at(
                    area,
                    state.view(&sessions),
                    ratatui::layout::Position::new(layout.details.x, selected_y)
                ),
                None
            );
            assert_eq!(
                pointer_target_at(
                    area,
                    state.view(&sessions),
                    ratatui::layout::Position::new(layout.list.x, layout.list.y - 1)
                ),
                None
            );
        }
    }
}
