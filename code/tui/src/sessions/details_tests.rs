use super::*;
use ash_protocol::AgentTreeProjection;
use ash_protocol::ThreadId;

fn response() -> SessionResult {
    let tree: AgentTreeProjection = serde_json::from_value(serde_json::json!({"roots": [
        {"threadId":"thread:session-1", "threadSequence":4, "title":"Coordinator", "executionStatus":"running", "usage":ash_protocol::ModelUsageSummary::default(), "children":[
            {"threadId":"agent-1", "threadSequence":2, "title":"Research", "parentThreadId":"thread:session-1", "executionStatus":"waiting", "waitingReason":"approval", "usage":ash_protocol::ModelUsageSummary::default(), "joins":[], "children":[
                {"threadId":"agent-2", "threadSequence":3, "title":"Tests", "parentThreadId":"agent-1", "executionStatus":"failed", "usage":ash_protocol::ModelUsageSummary::default()}
            ]}
        ], "joins":[{"joinId":"join-1", "parentThreadId":"thread:session-1", "policy":{"type":"all"}, "delegations":["delegation-1"], "status":"waiting", "satisfiedBy":[]}]},
        {"threadId":"fork-1", "threadSequence":1, "title":"Alternative", "forkedFromId":"thread:session-1", "executionStatus":"completed", "usage":ash_protocol::ModelUsageSummary::default()}
    ]})).unwrap();
    let mut threads = Vec::new();
    for (id, title) in [
        ("thread:session-1", "Coordinator"),
        ("agent-1", "Research"),
        ("agent-2", "Tests"),
        ("fork-1", "Alternative"),
    ] {
        threads.push(ash_protocol::SessionThread {
            thread_id: ThreadId::new(id).unwrap(),
            title: title.into(),
            created_at_unix_ms: 0,
            completed_turn_duration_ms: 0,
            active_turn_started_at_unix_ms: None,
            usage: Default::default(),
            parent_thread_id: None,
            forked_from_id: None,
            status: ash_protocol::ThreadStatus::Active,
        });
    }
    threads[2].status = ash_protocol::ThreadStatus::Archived;
    SessionResult {
        session: Session {
            session_id: SessionId::new("thread:session-1").unwrap(),
            title: "Coordinator".into(),
            status: ash_protocol::SessionStatus::Active,
            manager: ash_protocol::SessionManagerInfo {
                status: ash_protocol::SessionManagerStatus::Working,
                ..Default::default()
            },
            threads,
        },
        agent_tree: tree,
    }
}

#[test]
fn details_show_nested_agents_forks_waiting_and_lifecycle_separately() {
    let result = response();
    let detail = render_details(&result);
    let thread_rows = detail
        .rows()
        .iter()
        .filter(|row| row.label() == "Thread")
        .map(|row| row.value())
        .collect::<Vec<_>>();
    assert_eq!(
        thread_rows,
        [
            "Root · Coordinator · running",
            "  Agent · Research · waiting for approval",
            "    Agent · Tests · failed",
            "Fork · Alternative · completed"
        ]
    );
    assert!(
        detail
            .rows()
            .iter()
            .any(|row| row.label() == "Session ID" && row.value() == "session-1")
    );
    assert!(
        detail
            .rows()
            .iter()
            .any(|row| row.label() == "Lifecycle" && row.value() == "    archived")
    );
    assert!(
        detail
            .rows()
            .iter()
            .any(|row| row.label() == "Join" && row.value() == "waiting · 0 of 1 results received")
    );
    assert!(
        detail
            .rows()
            .iter()
            .any(|row| row.label() == "Forked from" && row.value() == "thread:session-1")
    );
    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(100, 45)).unwrap();
    let overlay = DetailOverlay::new(detail);
    terminal
        .draw(|frame| {
            crate::widgets::overlay::draw(
                frame,
                frame.area(),
                &overlay,
                crate::render::test_context(),
            )
        })
        .unwrap();
    crate::tui_assert_snapshot!("session_details_agent_tree", terminal.backend().to_string());
}

#[test]
fn details_ignore_closed_requests_refresh_and_do_not_reopen_after_deletion() {
    let result = response();
    let mut state = super::super::SessionsState::default();
    let mut navigation = crate::sessions::SessionNavigation::default();
    state.install_catalog(
        vec![result.session.clone()],
        result.session.session_id.clone(),
        result.session.threads[0].thread_id.clone(),
    );
    navigation.reconcile(&state);
    navigation.open_details(&state);
    let first = navigation.details.as_mut().unwrap().take_request().unwrap();
    assert!(
        navigation
            .details
            .as_mut()
            .unwrap()
            .take_request()
            .is_none()
    );
    navigation.details = None;
    navigation.reconcile(&state);
    navigation.open_details(&state);
    let second = navigation.details.as_mut().unwrap().take_request().unwrap();
    assert_ne!(first.0, second.0);
    navigation.finish_details(first.0, Err("old request".into()));
    navigation.finish_details(second.0, Ok(result.clone()));
    state.refresh_catalog(vec![result.session.clone()]);
    navigation.reconcile(&state);
    assert!(
        navigation
            .details
            .as_mut()
            .unwrap()
            .take_request()
            .is_some()
    );
    state.refresh_catalog(vec![]);
    navigation.reconcile(&state);
    navigation.finish_details(second.0, Ok(result));
    assert!(navigation.details.is_none());
}

#[test]
fn details_report_read_failure_and_preserve_scroll_on_refresh() {
    let result = response();
    let mut details = SessionDetails::new(&result.session, 1);
    details.take_request();
    details.install(Ok(result.clone()));
    let area = ratatui::layout::Rect::new(0, 0, 80, 10);
    details
        .overlay
        .scroll(crate::widgets::navigation::Navigation::Last, area);
    let render = |details: &SessionDetails| {
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 10)).unwrap();
        terminal
            .draw(|frame| {
                crate::widgets::overlay::draw(
                    frame,
                    frame.area(),
                    &details.overlay,
                    crate::render::test_context(),
                )
            })
            .unwrap();
        terminal.backend().to_string()
    };
    let before = render(&details);
    details.install(Ok(result));
    assert_eq!(render(&details), before);
    details.install(Err("connection closed".into()));
    assert!(render(&details).contains("connection closed"));
}

#[test]
fn details_poll_only_when_due_or_invalidated() {
    let result = response();
    let mut details = SessionDetails::new(&result.session, 9);
    assert_eq!(
        details.take_request(),
        Some((9, result.session.session_id.clone()))
    );
    assert!(details.take_request().is_none());
    details.last_read_at = Some(std::time::Instant::now() - std::time::Duration::from_secs(1));
    assert!(details.take_request().is_some());
    assert!(details.take_request().is_none());
    details.invalidate();
    assert!(details.take_request().is_some());
}
