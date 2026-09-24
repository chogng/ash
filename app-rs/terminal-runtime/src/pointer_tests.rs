use super::{PointerInput, TerminalPointer};
use ash_terminal::{GridSize, TerminalCore, TerminalMousePosition};
use zui::input::{ElementState, ModifiersState, MouseButton, MouseScrollDelta};

const FIRST: TerminalMousePosition = TerminalMousePosition::new(2, 4);
const SECOND: TerminalMousePosition = TerminalMousePosition::new(3, 5);

#[test]
fn pointer_is_owned_only_by_an_alternate_screen_requesting_mouse_reports() {
    let mut pointer = TerminalPointer::default();
    let mut terminal = TerminalCore::new(GridSize::default());

    assert_eq!(
        pointer.moved(&terminal, Some(FIRST), ModifiersState::default()),
        PointerInput::NotApplicable
    );

    terminal.process_output(b"\x1b[?1049h\x1b[?1000;1006h");
    assert_eq!(
        pointer.moved(&terminal, None, ModifiersState::default()),
        PointerInput::NotApplicable
    );
    assert_eq!(
        pointer.moved(&terminal, Some(FIRST), ModifiersState::default()),
        PointerInput::Consumed(Vec::new())
    );
    assert_eq!(
        pointer.button_changed(
            &terminal,
            None,
            MouseButton::Left,
            ElementState::Pressed,
            ModifiersState::default(),
        ),
        PointerInput::NotApplicable
    );
}

#[test]
fn button_event_tracking_preserves_held_button_for_motion_and_release() {
    let mut pointer = TerminalPointer::default();
    let mut terminal = TerminalCore::new(GridSize::default());
    terminal.process_output(b"\x1b[?1049h\x1b[?1002;1006h");

    assert_eq!(
        pointer.button_changed(
            &terminal,
            Some(FIRST),
            MouseButton::Left,
            ElementState::Pressed,
            ModifiersState::default(),
        ),
        PointerInput::Consumed(b"\x1b[<0;5;3M".to_vec())
    );
    assert_eq!(
        pointer.moved(&terminal, Some(SECOND), ModifiersState::default()),
        PointerInput::Consumed(b"\x1b[<32;6;4M".to_vec())
    );
    assert_eq!(
        pointer.button_changed(
            &terminal,
            None,
            MouseButton::Left,
            ElementState::Released,
            ModifiersState::default(),
        ),
        PointerInput::Consumed(b"\x1b[<0;6;4m".to_vec())
    );
}

#[test]
fn vertical_wheel_delta_maps_to_terminal_wheel_buttons() {
    let mut pointer = TerminalPointer::default();
    let mut terminal = TerminalCore::new(GridSize::default());
    terminal.process_output(b"\x1b[?1049h\x1b[?1000;1006h");

    assert_eq!(
        pointer.wheel(
            &terminal,
            Some(FIRST),
            MouseScrollDelta::LineDelta(0.0, 1.0),
            ModifiersState::default(),
        ),
        PointerInput::Consumed(b"\x1b[<64;5;3M".to_vec())
    );
}
