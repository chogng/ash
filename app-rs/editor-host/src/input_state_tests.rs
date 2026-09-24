use super::FileEditorInputState;
use super::FileEditorWheelDelta;
use crate::FileEditorPrompt;

#[test]
fn diagnostic_hover_state_invalidates_only_when_the_hit_range_changes() {
    let mut state = FileEditorInputState::default();

    assert!(state.update_hovered_diagnostic(Some(4..8)));
    assert!(!state.update_hovered_diagnostic(Some(4..8)));
    assert!(state.update_hovered_diagnostic(Some(12..16)));
    assert!(state.update_hovered_diagnostic(None));
}

#[test]
fn line_wheel_maps_platform_direction_to_editor_rows() {
    let mut state = FileEditorInputState::default();

    assert_eq!(state.wheel_rows(FileEditorWheelDelta::Lines(-1.0), 20.0), 3);
    assert_eq!(state.wheel_rows(FileEditorWheelDelta::Lines(1.0), 20.0), -3);
}

#[test]
fn pixel_wheel_accumulates_sub_row_motion() {
    let mut state = FileEditorInputState::default();

    assert_eq!(
        state.wheel_rows(FileEditorWheelDelta::Pixels(-8.0), 20.0),
        0
    );
    assert_eq!(
        state.wheel_rows(FileEditorWheelDelta::Pixels(-12.0), 20.0),
        1
    );
}

#[test]
fn close_confirmation_is_ephemeral_desktop_input_state() {
    let mut state = FileEditorInputState::default();

    assert_eq!(state.prompt(), FileEditorPrompt::None);
    state.confirm_close();
    assert_eq!(state.prompt(), FileEditorPrompt::ConfirmClose);
    state.dismiss_prompt();
    assert_eq!(state.prompt(), FileEditorPrompt::None);
}
