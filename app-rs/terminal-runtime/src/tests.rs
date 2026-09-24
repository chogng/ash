//! Terminal runtime and pane-adoption contract tests.

use super::{
    ActivationDecision, EnsureReservation, PendingTerminalReservation, TerminalReadyPlacement,
    TerminalRuntimeState,
};
use ash_protocol::SessionId;

fn session_id(value: &str) -> SessionId {
    SessionId::new(value).expect("test session ID is non-empty")
}

#[test]
fn pending_sessions_get_distinct_terminal_keys_before_pty_creation_finishes() {
    let mut state = TerminalRuntimeState::default();
    let initial_key = state
        .reserve_initial()
        .expect("initial terminal reservation");
    let first_session = session_id("session-1");
    let second_session = session_id("session-2");

    assert_eq!(
        state.ensure_for_session(&first_session),
        EnsureReservation::Pending(PendingTerminalReservation::Existing(initial_key))
    );
    let second_key = match state.ensure_for_session(&second_session) {
        EnsureReservation::Pending(PendingTerminalReservation::Start(key)) => key,
        reservation => panic!("expected a new pending terminal, got {reservation:?}"),
    };
    assert_ne!(initial_key, second_key);

    assert_eq!(
        state.activation_for_session(&second_session),
        ActivationDecision::Pending(second_key)
    );
    assert_eq!(
        state.finish_pending(initial_key),
        Some(TerminalReadyPlacement::Inactive)
    );
    assert_eq!(
        state.finish_pending(second_key),
        Some(TerminalReadyPlacement::Active)
    );
    assert_eq!(state.active_key, Some(second_key));
}

#[test]
fn add_session_reserves_one_independent_terminal_pane_and_activates_it_when_ready() {
    let mut state = TerminalRuntimeState::default();
    let initial_key = state
        .reserve_initial()
        .expect("initial terminal reservation");
    let first_session = session_id("session-1");
    let second_session = session_id("session-2");

    assert_eq!(
        state.ensure_for_session(&first_session),
        EnsureReservation::Pending(PendingTerminalReservation::Existing(initial_key))
    );
    assert_eq!(
        state.finish_pending(initial_key),
        Some(TerminalReadyPlacement::Active)
    );
    let second_key = match state.ensure_for_session(&second_session) {
        EnsureReservation::Pending(PendingTerminalReservation::Start(key)) => key,
        reservation => panic!("expected Add Session to reserve a new pane, got {reservation:?}"),
    };
    assert_eq!(state.session_terminal_keys.len(), 2);
    assert_ne!(
        state.session_terminal_keys.get(&first_session),
        state.session_terminal_keys.get(&second_session)
    );
    assert_eq!(
        state.activation_for_session(&second_session),
        ActivationDecision::Pending(second_key)
    );
    assert_eq!(state.active_key, Some(initial_key));

    assert_eq!(
        state.finish_pending(second_key),
        Some(TerminalReadyPlacement::Active)
    );
    assert_eq!(state.active_key, Some(second_key));
}

#[test]
fn switching_back_before_a_new_pane_is_ready_does_not_steal_activation() {
    let mut state = TerminalRuntimeState::default();
    let initial_key = state
        .reserve_initial()
        .expect("initial terminal reservation");
    let first_session = session_id("session-1");
    let second_session = session_id("session-2");

    state.ensure_for_session(&first_session);
    assert_eq!(
        state.finish_pending(initial_key),
        Some(TerminalReadyPlacement::Active)
    );
    let second_key = match state.ensure_for_session(&second_session) {
        EnsureReservation::Pending(PendingTerminalReservation::Start(key)) => key,
        reservation => panic!("expected a pending second pane, got {reservation:?}"),
    };
    assert_eq!(
        state.activation_for_session(&second_session),
        ActivationDecision::Pending(second_key)
    );
    assert_eq!(
        state.activation_for_session(&first_session),
        ActivationDecision::AlreadyActive
    );
    assert_eq!(
        state.finish_pending(second_key),
        Some(TerminalReadyPlacement::Inactive)
    );
    assert_eq!(state.active_key, Some(initial_key));
}

#[test]
fn initial_terminal_becomes_active_when_no_tab_switch_is_pending() {
    let mut state = TerminalRuntimeState::default();
    let initial_key = state
        .reserve_initial()
        .expect("initial terminal reservation");

    assert_eq!(
        state.finish_pending(initial_key),
        Some(TerminalReadyPlacement::Active)
    );
    assert_eq!(state.active_key, Some(initial_key));
}

#[test]
fn failed_pending_terminal_releases_session_binding_for_a_retry() {
    let mut state = TerminalRuntimeState::default();
    let session = session_id("session-1");
    let reservation = match state.ensure_for_session(&session) {
        EnsureReservation::Pending(PendingTerminalReservation::Start(key)) => key,
        reservation => panic!("expected a new pending terminal, got {reservation:?}"),
    };

    assert!(state.fail_pending(reservation));
    assert_eq!(
        state.activation_for_session(&session),
        ActivationDecision::Missing
    );
    assert!(matches!(
        state.ensure_for_session(&session),
        EnsureReservation::Pending(PendingTerminalReservation::Start(_))
    ));
}

#[test]
fn standalone_pane_keys_can_bind_to_the_current_session_and_activate() {
    let mut state = TerminalRuntimeState::default();
    let root = state
        .reserve_initial()
        .expect("initial terminal reservation");
    let session = session_id("session-1");
    state.ensure_for_session(&session);
    assert_eq!(
        state.finish_pending(root),
        Some(TerminalReadyPlacement::Active)
    );

    let pane = state.reserve_standalone();
    state.bind_key_to_session(pane, session.clone());

    assert_eq!(state.session_id_for_key(pane), Some(session));
    assert_eq!(
        state.activation_for_key(pane),
        ActivationDecision::Pending(pane)
    );
    assert_eq!(
        state.finish_pending(pane),
        Some(TerminalReadyPlacement::Active)
    );
    assert_eq!(state.active_key, Some(pane));
}
