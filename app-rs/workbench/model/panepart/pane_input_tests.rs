//! Application pane input description tests.

use std::path::PathBuf;

use super::PaneInput;
use super::PaneInputKind;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;

fn session(value: &str) -> SessionId {
    SessionId::new(value).expect("test session ID is non-empty")
}

fn thread(value: &str) -> ThreadId {
    ThreadId::new(value).expect("test thread ID is non-empty")
}

#[test]
fn pane_input_separates_kind_from_layout_instance() {
    let terminal = PaneInput::terminal(session("session-1"));
    let agent = PaneInput::agent(session("session-1"), thread("thread-1"));
    let files = PaneInput::files(PathBuf::from("/dir"));
    let diff = PaneInput::diff(PathBuf::from("/dir"));
    let settings = PaneInput::settings();

    assert_eq!(terminal.kind(), PaneInputKind::Terminal);
    assert_eq!(agent.kind(), PaneInputKind::Agent);
    assert_eq!(files.kind(), PaneInputKind::Files);
    assert_eq!(diff.kind(), PaneInputKind::Diff);
    assert_eq!(settings.kind(), PaneInputKind::Settings);
    assert_ne!(terminal, agent);
    assert_ne!(files, diff);
}

#[test]
fn terminal_input_contains_only_the_session_description() {
    let session_id = session("session-1");
    let terminal = PaneInput::Terminal(session_id.clone());

    assert_eq!(terminal.terminal_session_id(), Some(&session_id));
    assert_eq!(terminal.dir_root(), None);
    assert_eq!(terminal.agent_session_id(), None);
    assert_eq!(terminal.thread_id(), None);
}

#[test]
fn agent_inputs_are_distinct_by_thread_identity() {
    let first = PaneInput::agent(session("session-1"), thread("thread-1"));
    let second = PaneInput::agent(session("session-1"), thread("thread-2"));

    assert_ne!(first, second);
}
