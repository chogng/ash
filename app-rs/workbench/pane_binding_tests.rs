use super::PaneBinding;
use crate::PaneInput;
use crate::terminal_session::TerminalSessionKey;
use ash_protocol::SessionId;

fn session(value: &str) -> SessionId {
    SessionId::new(value).expect("test session ID is non-empty")
}

#[test]
fn pane_binding_keeps_only_the_optional_runtime() {
    let binding = PaneBinding::new();

    assert_eq!(binding.terminal_key(), None);

    let terminal = PaneBinding::terminal(TerminalSessionKey::new(7));
    assert_eq!(terminal.terminal_key(), Some(TerminalSessionKey::new(7)));
}

#[test]
fn non_terminal_binding_rejects_terminal_runtime() {
    let mut binding = PaneBinding::new();
    let input = PaneInput::settings();

    assert!(!binding.bind_terminal(&input, &session("session-1"), TerminalSessionKey::new(1),));
    assert_eq!(binding.terminal_key(), None);
}
