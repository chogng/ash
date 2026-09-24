use super::SessionManagerInputOutcome;
use super::SessionNavigation;
use super::SessionScreen;
use crate::sessions::Command;
use crate::sessions::SessionsState;
use ash_protocol::Session;
use ash_protocol::SessionId;
use ash_protocol::SessionManagerStatus;
use ash_protocol::SessionStatus;
use ash_protocol::ThreadId;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;

#[test]
fn manager_is_directly_left_of_the_active_session() {
    let mut state = SessionsState::default();
    let mut navigation = SessionNavigation::default();
    state.install_catalog(
        vec![session("one"), session("two")],
        session_id("one"),
        thread_id("one"),
    );
    navigation.context_changed(&state);
    navigation.reconcile(&state);

    assert_eq!(navigation.previous_screen(), Some(SessionScreen::Manager));
    navigation.show_manager(&state);
    assert_eq!(navigation.previous_screen(), None);
    assert_eq!(
        navigation.next_screen(&state),
        Some(SessionScreen::Session(session_id("one")))
    );
}

#[test]
fn historical_sessions_are_not_horizontal_screens() {
    let mut completed = session("completed");
    completed.manager.status = SessionManagerStatus::Completed;
    let mut working = session("working");
    working.manager.status = SessionManagerStatus::Working;
    let mut question = session("question");
    question.manager.status = SessionManagerStatus::NeedsInput;
    let mut state = SessionsState::default();
    let mut navigation = SessionNavigation::default();
    state.install_catalog(
        vec![completed, working, question],
        session_id("completed"),
        thread_id("completed"),
    );
    navigation.context_changed(&state);
    navigation.reconcile(&state);

    navigation.show_manager(&state);
    assert_eq!(
        navigation.next_screen(&state),
        Some(SessionScreen::Session(session_id("completed")))
    );
    state.activate_context(session_id("working"), thread_id("working"));
    navigation.show_session(session_id("working"));
    assert_eq!(navigation.previous_screen(), Some(SessionScreen::Manager));
    assert_eq!(navigation.next_screen(&state), None);
    navigation.show_manager(&state);
    assert_eq!(
        navigation.next_screen(&state),
        Some(SessionScreen::Session(session_id("working")))
    );
}

#[test]
fn showing_a_session_clears_manager_focus() {
    let mut state = SessionsState::default();
    let mut navigation = SessionNavigation::default();
    state.install_catalog(vec![session("one")], session_id("one"), thread_id("one"));
    navigation.context_changed(&state);
    navigation.reconcile(&state);
    navigation.show_manager(&state);
    navigation.manager_mut().focus();

    state.activate_context(session_id("one"), thread_id("one"));
    navigation.show_session(session_id("one"));

    assert_eq!(
        navigation.screen(),
        Some(&SessionScreen::Session(session_id("one")))
    );
    assert!(!navigation.manager().focused());
}

#[test]
fn manager_input_requires_a_visible_focused_manager_and_resumes_the_remembered_thread() {
    let mut state = SessionsState::default();
    let mut navigation = SessionNavigation::default();
    state.install_catalog(vec![session("one")], session_id("one"), thread_id("child"));
    navigation.context_changed(&state);
    navigation.reconcile(&state);
    let enter = KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE);
    navigation.manager_mut().focus();
    assert!(matches!(
        navigation.handle_manager_key(&state, enter),
        SessionManagerInputOutcome::Unhandled
    ));
    navigation.show_manager(&state);
    navigation.manager_mut().blur();
    assert!(matches!(
        navigation.handle_manager_key(&state, enter),
        SessionManagerInputOutcome::Unhandled
    ));
    navigation.manager_mut().focus();
    let SessionManagerInputOutcome::Command(command) = navigation.handle_manager_key(&state, enter)
    else {
        panic!("focused manager must resume the selected session");
    };
    assert_eq!(
        command,
        Command::Resume {
            session_id: "one".into(),
            preferred_thread_id: Some(thread_id("child")),
        }
    );
    assert_eq!(navigation.screen(), Some(&SessionScreen::Manager));
}

#[test]
fn manager_repeats_only_navigation_and_keeps_mutations_for_key_presses() {
    let mut state = SessionsState::default();
    let mut navigation = SessionNavigation::default();
    state.install_catalog(vec![session("one")], session_id("one"), thread_id("one"));
    navigation.context_changed(&state);
    navigation.reconcile(&state);
    navigation.show_manager(&state);
    navigation.manager_mut().focus();
    for kind in [KeyEventKind::Repeat, KeyEventKind::Release] {
        for (code, modifiers) in [
            (KeyCode::Enter, KeyModifiers::NONE),
            (KeyCode::Char(' '), KeyModifiers::NONE),
            (KeyCode::Char('i'), KeyModifiers::NONE),
            (KeyCode::Char('p'), KeyModifiers::NONE),
            (KeyCode::Char('x'), KeyModifiers::CONTROL),
        ] {
            assert!(matches!(
                navigation
                    .handle_manager_key(&state, KeyEvent::new_with_kind(code, modifiers, kind)),
                SessionManagerInputOutcome::Unhandled
            ));
        }
    }
    assert!(navigation.preview.is_none());
    assert!(navigation.details.is_none());
    assert!(matches!(
        navigation.handle_manager_key(
            &state,
            KeyEvent::new_with_kind(KeyCode::Home, KeyModifiers::NONE, KeyEventKind::Repeat)
        ),
        SessionManagerInputOutcome::Consumed
    ));
    // Home selects the group heading; Down selects its first session.
    navigation.handle_manager_key(&state, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    let SessionManagerInputOutcome::Command(command) = navigation.handle_manager_key(
        &state,
        KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL),
    ) else {
        panic!("a key press must archive the selected active session");
    };
    assert_eq!(
        command,
        Command::Archive {
            session_ids: vec![session_id("one")]
        }
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
