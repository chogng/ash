use std::time::Duration;
use std::time::Instant;

use ash_commands::AppCommandId;
use ash_keybinding::Chord;
use ash_keybinding::HostPlatform;
use ash_keybinding::ShortcutModifiers;
use ash_keybinding::serialize_key_sequence;
use zui::ui::CaretVisibility;
use zui::ui::Color;
use zui::ui::InteractionFrame;
use zui::ui::Point;
use zui::ui::Rect;
use zui::ui::TextInput;
use zui::ui::TextInputLayoutEngine;
use zui::ui::UiDispatch;
use zui::ui::UiFrame;

use super::KeyboardShortcuts;
use super::KeyboardShortcutsState;
use super::keyboard_shortcut_row_element;
use super::keyboard_shortcut_rows;
use super::keyboard_shortcuts_ids;

#[test]
fn recording_collects_chords_and_commits_after_the_quiet_period() {
    let now = Instant::now();
    let mut state = KeyboardShortcutsState::default();
    state.start_recording(AppCommandId::ToggleTabContainer);
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
    assert_eq!(commit.command, AppCommandId::ToggleTabContainer);
    assert_eq!(
        serialize_key_sequence(&commit.keybinding),
        "primary+k primary+b"
    );
}

#[test]
fn every_bindable_command_has_a_distinct_stable_row() {
    let mut ids = AppCommandId::BINDABLE
        .into_iter()
        .map(keyboard_shortcut_row_element)
        .collect::<Vec<_>>();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), AppCommandId::BINDABLE.len());
}

#[test]
fn visible_shortcuts_are_modal_and_paint_keycaps() {
    let state = KeyboardShortcutsState::default();
    let search = TextInput::default();
    let rows = keyboard_shortcut_rows(|_| None);
    let dispatch = UiDispatch::default();
    let mut text_layout = TextInputLayoutEngine::default();
    let shortcuts = KeyboardShortcuts::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        &state,
        &search,
        &rows,
        &[],
        keyboard_shortcuts_ids(zui::ui::ElementId::scoped(1, 1)),
        HostPlatform::current(),
        CaretVisibility::Visible,
        &mut text_layout,
        &dispatch,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
    frame.draw_component(&shortcuts);

    assert!(
        frame
            .interaction()
            .target_at(Point::new(0.0, 0.0))
            .is_none()
    );
    assert!(
        frame
            .interaction()
            .node(keyboard_shortcut_row_element(AppCommandId::Copy))
            .is_some()
    );
}
