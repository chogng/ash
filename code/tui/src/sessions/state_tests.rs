use super::SessionsState;
use ash_protocol::Session;
use ash_protocol::SessionId;
use ash_protocol::SessionStatus;
use ash_protocol::SessionThread;
use ash_protocol::ThreadId;
use ash_protocol::ThreadStatus;

#[test]
fn each_session_remembers_its_last_viewed_thread() {
    let mut state = SessionsState::default();
    state.install_catalog(vec![session("one")], session_id("one"), thread_id("root"));
    state.remember_viewed_thread(session_id("one"), thread_id("child"));

    assert_eq!(
        state.remembered_thread(&session_id("one")),
        Some(&thread_id("child"))
    );
}

#[test]
fn reentering_a_session_falls_back_to_main_after_the_viewed_subagent_completes() {
    let mut catalog_session = session("one");
    catalog_session.threads = vec![
        SessionThread {
            thread_id: thread_id("one"),
            title: "main".into(),
            created_at_unix_ms: 1,
            completed_turn_duration_ms: 0,
            active_turn_started_at_unix_ms: None,
            usage: Default::default(),
            parent_thread_id: None,
            forked_from_id: None,
            status: ThreadStatus::Active,
        },
        SessionThread {
            thread_id: thread_id("child"),
            title: "child".into(),
            created_at_unix_ms: 2,
            completed_turn_duration_ms: 0,
            active_turn_started_at_unix_ms: None,
            usage: Default::default(),
            parent_thread_id: Some(thread_id("one")),
            forked_from_id: None,
            status: ThreadStatus::Archived,
        },
    ];
    let mut state = SessionsState::default();
    state.install_catalog(vec![catalog_session], session_id("one"), thread_id("child"));

    assert_eq!(
        state.restorable_thread(&session_id("one")),
        Some(thread_id("one"))
    );
}

fn session(value: &str) -> Session {
    Session {
        session_id: session_id(value),
        title: value.into(),
        status: SessionStatus::Active,
        manager: Default::default(),
        threads: Vec::new(),
    }
}

fn session_id(value: &str) -> SessionId {
    SessionId::new(value).unwrap()
}

fn thread_id(value: &str) -> ThreadId {
    ThreadId::new(value).unwrap()
}
