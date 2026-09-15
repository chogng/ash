use super::AgentThreadSwitcher;
use super::draw_agent_thread_switcher;
use crate::render::test_context;
use ash_protocol::Session;
use ash_protocol::SessionId;
use ash_protocol::SessionStatus;
use ash_protocol::SessionThread;
use ash_protocol::ThreadId;
use ash_protocol::ThreadStatus;
use ratatui::Terminal;
use ratatui::backend::TestBackend;

#[test]
fn completed_subagents_disappear_without_changing_stable_selection() {
    let mut session = session();
    let mut switcher = AgentThreadSwitcher::default();
    let selected = thread_id("child-b");
    switcher.reconcile(Some(&session), Some(&selected));
    switcher.focus();

    session.threads[1].status = ThreadStatus::Archived;
    switcher.reconcile(Some(&session), Some(&selected));

    assert_eq!(switcher.selected(), Some(&selected));
    assert_eq!(switcher.view().rows.len(), 2);
}

#[test]
fn selection_drives_a_bounded_viewport() {
    let mut session = session();
    for index in 0..6 {
        session.threads.push(child(&format!("extra-{index}")));
    }
    let mut switcher = AgentThreadSwitcher::default();
    switcher.reconcile(Some(&session), Some(&thread_id("root")));
    switcher.focus();
    for _ in 0..6 {
        switcher.navigate(crate::widgets::navigation::Navigation::Next);
    }

    assert_eq!(switcher.view().rows.len(), 4);
    assert!(
        switcher
            .view()
            .rows
            .iter()
            .any(|row| Some(&row.thread_id) == switcher.selected())
    );
}

#[test]
fn rows_use_selection_dots_lowercase_names_and_right_aligned_elapsed_time() {
    let mut session = session();
    session.threads[1].title = "Review Agent".into();
    session.threads[0].completed_turn_duration_ms = 61_000;
    session.threads[1].completed_turn_duration_ms = 21_000;
    session.threads[1].active_turn_started_at_unix_ms = Some(52_000);
    let mut switcher = AgentThreadSwitcher::default();
    switcher.reconcile(Some(&session), Some(&thread_id("child-a")));
    switcher.now_unix_ms = 62_000;
    let backend = TestBackend::new(30, 2);
    let mut terminal = Terminal::new(backend).unwrap();

    terminal
        .draw(|frame| {
            draw_agent_thread_switcher(
                frame,
                frame.area(),
                switcher.view(),
                None,
                None,
                test_context(),
            )
        })
        .unwrap();

    let buffer = terminal.backend().buffer();
    let rows = (0..2)
        .map(|row| {
            (0..30)
                .map(|column| buffer[(column, row)].symbol())
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    assert_eq!(rows[0].trim_end(), "○ main                  1m 01s");
    assert_eq!(rows[1].trim_end(), "● review agent             31s");
    assert!(!rows.join("\n").contains("child-a"));
    assert_eq!(buffer[(0, 0)].fg, test_context().muted());
    assert_eq!(buffer[(0, 1)].fg, test_context().foreground());
}

#[test]
fn viewed_thread_and_focused_cursor_keep_separate_visual_identities() {
    let session = session();
    let mut switcher = AgentThreadSwitcher::default();
    switcher.reconcile(Some(&session), Some(&thread_id("child-a")));
    switcher.focus();
    switcher.navigate(crate::widgets::navigation::Navigation::Next);
    let mut terminal = Terminal::new(TestBackend::new(30, 3)).unwrap();

    terminal
        .draw(|frame| {
            draw_agent_thread_switcher(
                frame,
                frame.area(),
                switcher.view(),
                None,
                None,
                test_context(),
            )
        })
        .unwrap();
    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(0, 1)].symbol(), "●");
    assert_eq!(
        buffer[(0, 1)].bg,
        test_context().accent_surface_background()
    );
    assert_eq!(buffer[(0, 2)].symbol(), "○");
    assert_eq!(buffer[(0, 2)].bg, test_context().selection_background());

    switcher.blur();
    terminal
        .draw(|frame| {
            draw_agent_thread_switcher(
                frame,
                frame.area(),
                switcher.view(),
                None,
                None,
                test_context(),
            )
        })
        .unwrap();
    let buffer = terminal.backend().buffer();
    assert_eq!(
        buffer[(0, 1)].bg,
        test_context().accent_surface_background()
    );
    assert_eq!(buffer[(0, 2)].fg, test_context().muted());
}

#[test]
fn switcher_is_absent_without_an_active_subagent() {
    let mut session = session();
    session.threads.truncate(1);
    let mut switcher = AgentThreadSwitcher::default();

    switcher.reconcile(Some(&session), Some(&thread_id("root")));

    assert_eq!(switcher.desired_rows(), 0);
    assert!(switcher.view().rows.is_empty());
    assert!(!switcher.focus());
}

#[test]
fn pointer_hover_uses_the_complete_thread_row_without_moving_keyboard_focus() {
    let session = session();
    let mut switcher = AgentThreadSwitcher::default();
    let active = thread_id("child-a");
    switcher.reconcile(Some(&session), Some(&active));
    let area = ratatui::layout::Rect::new(0, 0, 30, 3);
    let target = super::pointer_target_at(
        area,
        switcher.view(),
        ratatui::layout::Position::new(area.right() - 1, 2),
    )
    .unwrap();
    assert_eq!(target, thread_id("child-b"));
    assert!(!switcher.focused());

    let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
    terminal
        .draw(|frame| {
            draw_agent_thread_switcher(
                frame,
                area,
                switcher.view(),
                Some(&target),
                None,
                test_context(),
            )
        })
        .unwrap();
    for column in area.x..area.right() {
        assert_eq!(
            terminal.backend().buffer()[(column, 2)].bg,
            test_context().hover_background()
        );
    }
    assert!(switcher.focus_pointer(&target));
    assert_eq!(switcher.selected(), Some(&target));
}

fn session() -> Session {
    Session {
        session_id: session_id("root"),
        title: "Session".into(),
        status: SessionStatus::Active,
        manager: Default::default(),
        threads: vec![root(), child("child-a"), child("child-b")],
    }
}

fn root() -> SessionThread {
    SessionThread {
        thread_id: thread_id("root"),
        title: "Main Task".into(),
        created_at_unix_ms: 1_000,
        completed_turn_duration_ms: 0,
        active_turn_started_at_unix_ms: None,
        usage: Default::default(),
        parent_thread_id: None,
        forked_from_id: None,
        status: ThreadStatus::Active,
    }
}

fn child(value: &str) -> SessionThread {
    SessionThread {
        thread_id: thread_id(value),
        title: value.into(),
        created_at_unix_ms: 1_000,
        completed_turn_duration_ms: 0,
        active_turn_started_at_unix_ms: None,
        usage: Default::default(),
        parent_thread_id: Some(thread_id("root")),
        forked_from_id: None,
        status: ThreadStatus::Active,
    }
}

fn session_id(value: &str) -> SessionId {
    SessionId::new(value).unwrap()
}

fn thread_id(value: &str) -> ThreadId {
    ThreadId::new(value).unwrap()
}
