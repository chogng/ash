use super::*;
use ash_protocol::SessionManagerActivity;
use ash_protocol::SessionManagerInfo;

pub(super) fn session(
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
    state.selected = Some(SessionManagerTarget::Session(
        SessionId::new("completed").unwrap(),
    ));
    assert!(state.toggle_selected_pin());

    let labels = manager_items(&sessions, &state.pinned, &state.collapsed, state.grouping)
        .into_iter()
        .map(|item| match item {
            ManagerItem::Heading { group, .. } => group.label().into_owned(),
            ManagerItem::Session(session) => session.session_id.to_string(),
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
        let expanded = manager_items(&sessions, &state.pinned, &state.collapsed, state.grouping)
            .iter()
            .map(ManagerItem::target)
            .collect::<Vec<_>>();
        state.toggle_selected_group();
        state.reconcile(&sessions);
        assert_eq!(state.selected_group(), Some(group.clone()));
        assert_eq!(
            state.selection_hint().text(),
            "Enter/→ to expand · g to group · Esc to return"
        );
        let collapsed = manager_items(&sessions, &state.pinned, &state.collapsed, state.grouping)
            .iter()
            .map(ManagerItem::target)
            .collect::<Vec<_>>();
        let expected = expanded
            .iter()
            .filter(|target| match target {
                SessionManagerTarget::Session(id) => !sessions.iter().any(|session| {
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
            "Enter/← to collapse · g to group · Esc to return"
        );
        assert_eq!(
            manager_items(&sessions, &state.pinned, &state.collapsed, state.grouping)
                .iter()
                .map(ManagerItem::target)
                .collect::<Vec<_>>(),
            expanded
        );
    }
}
