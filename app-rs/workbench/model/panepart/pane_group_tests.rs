//! Pane group logical input tests.

use super::{PaneGroup, PaneInputId};
use crate::PaneInput;
use ash_protocol::{SessionId, ThreadId};

fn session(id: &str) -> SessionId {
    SessionId::new(id).expect("test session ID is non-empty")
}

fn thread(id: &str) -> ThreadId {
    ThreadId::new(id).expect("test thread ID is non-empty")
}

#[test]
fn a_group_starts_empty_and_opens_an_active_input() {
    let mut group = PaneGroup::new();

    assert_eq!(group.input_ids(), []);
    assert_eq!(group.active_input_id(), None);

    let input_id = group.open_input(PaneInput::terminal(session("session-1")));

    assert_eq!(input_id.value(), 1);
    assert_eq!(input_id, PaneInputId::from_value(1));
    assert_eq!(group.active_input_id(), Some(input_id));
    assert_eq!(
        group.active_input().unwrap().kind(),
        PaneInput::terminal(session("session-1")).kind()
    );
}

#[test]
fn a_group_keeps_input_identity_when_replacing_content() {
    let mut group =
        PaneGroup::with_input(PaneInput::agent(session("session-1"), thread("thread-1")));
    let input_id = group.active_input_id().expect("active input");

    let previous = group
        .replace_active_input(PaneInput::files("/dir".into()))
        .expect("previous input");

    assert_eq!(previous.kind(), crate::PaneInputKind::Agent);
    assert_eq!(group.active_input_id(), Some(input_id));
    assert_eq!(
        group.input(input_id).unwrap().kind(),
        crate::PaneInputKind::Files
    );
}

#[test]
fn adding_an_input_keeps_the_existing_input_active() {
    let mut group = PaneGroup::new();
    let first = group.add_input(PaneInput::terminal(session("session-1")));
    let second = group.add_input(PaneInput::files("/dir".into()));

    assert_eq!(group.active_input_id(), Some(first));
    assert_eq!(group.input(second), Some(&PaneInput::files("/dir".into())));
}

#[test]
fn closing_active_input_selects_the_nearest_remaining_input() {
    let mut group = PaneGroup::new();
    let first = group.open_input(PaneInput::settings());
    let second = group.open_input(PaneInput::files("/dir".into()));

    assert_eq!(
        group.close_input(second).unwrap().kind(),
        crate::PaneInputKind::Files
    );
    assert_eq!(group.active_input_id(), Some(first));
}
