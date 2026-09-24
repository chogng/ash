use std::time::Duration;
use std::time::Instant;

use ash_keybinding::Chord;
use ash_keybinding::ShortcutModifiers;
use ash_keybinding::serialize_key_sequence;

use super::KeyboardShortcutsState;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Command {
    ToggleSidebar,
}

#[test]
fn recording_collects_chords_and_commits_after_the_quiet_period() {
    let now = Instant::now();
    let mut state = KeyboardShortcutsState::default();
    state.start_recording(Command::ToggleSidebar);
    state.record(
        Chord::logical("k", ShortcutModifiers::primary()).expect("first chord"),
        now,
    );
    state.record(
        Chord::logical("b", ShortcutModifiers::primary()).expect("second chord"),
        now + Duration::from_millis(100),
    );

    assert!(state.advance(now + Duration::from_millis(500)).is_none());
    let commit = state
        .advance(now + Duration::from_millis(1_200))
        .expect("completed recording");
    assert_eq!(commit.command, Command::ToggleSidebar);
    assert_eq!(
        serialize_key_sequence(&commit.keybinding),
        "primary+k primary+b"
    );
}

#[test]
fn escape_and_window_blur_can_cancel_recording_without_closing_the_surface() {
    let mut state = KeyboardShortcutsState::default();
    state.start_recording(Command::ToggleSidebar);
    state.cancel_recording();
    assert!(!state.is_recording());

    state.start_recording(Command::ToggleSidebar);
    state.window_blurred();
    assert!(!state.is_recording());
}

#[test]
fn reset_clears_the_active_recording() {
    let mut state = KeyboardShortcutsState::<Command>::default();
    state.start_recording(Command::ToggleSidebar);

    state.reset();

    assert!(!state.is_recording());
}
