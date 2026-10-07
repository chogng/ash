use super::{
    MouseModifiers, TerminalMouseButton, TerminalMouseButtonState, TerminalMouseEvent,
    TerminalMousePosition,
};
use crate::{GridSize, TerminalCore};

const POSITION: TerminalMousePosition = TerminalMousePosition::new(2, 4);

#[test]
fn disabled_tracking_suppresses_mouse_reports() {
    let terminal = TerminalCore::new(GridSize::default());

    assert!(
        terminal
            .encode_mouse(TerminalMouseEvent::press(
                TerminalMouseButton::Left,
                POSITION
            ))
            .is_empty()
    );
}

#[test]
fn sgr_tracking_encodes_press_release_wheel_and_modifiers() {
    let mut terminal = TerminalCore::new(GridSize::default());
    terminal.process_output(b"\x1b[?1000;1006h");

    assert_eq!(
        terminal.encode_mouse(TerminalMouseEvent::press(
            TerminalMouseButton::Left,
            POSITION
        )),
        b"\x1b[<0;5;3M"
    );
    assert_eq!(
        terminal.encode_mouse(TerminalMouseEvent::release(
            TerminalMouseButton::Left,
            POSITION
        )),
        b"\x1b[<0;5;3m"
    );
    assert_eq!(
        terminal.encode_mouse(
            TerminalMouseEvent::press(TerminalMouseButton::WheelDown, POSITION)
                .with_modifiers(MouseModifiers::NONE.with_shift().with_alt().with_control())
        ),
        b"\x1b[<93;5;3M"
    );
}

#[test]
fn button_event_tracking_reports_motion_only_while_a_button_is_held() {
    let mut terminal = TerminalCore::new(GridSize::default());
    terminal.process_output(b"\x1b[?1002;1006h");

    assert!(
        terminal
            .encode_mouse(TerminalMouseEvent::motion(
                TerminalMouseButtonState::None,
                POSITION
            ))
            .is_empty()
    );
    assert_eq!(
        terminal.encode_mouse(TerminalMouseEvent::motion(
            TerminalMouseButtonState::Left,
            POSITION
        )),
        b"\x1b[<32;5;3M"
    );
}

#[test]
fn any_event_tracking_reports_motion_without_a_pressed_button() {
    let mut terminal = TerminalCore::new(GridSize::default());
    terminal.process_output(b"\x1b[?1003;1006h");

    assert_eq!(
        terminal.encode_mouse(TerminalMouseEvent::motion(
            TerminalMouseButtonState::None,
            POSITION
        )),
        b"\x1b[<35;5;3M"
    );
}

#[test]
fn legacy_tracking_uses_x10_bytes_and_clamps_large_coordinates() {
    let mut terminal = TerminalCore::new(GridSize::default());
    terminal.process_output(b"\x1b[?1000h");

    assert_eq!(
        terminal.encode_mouse(TerminalMouseEvent::press(
            TerminalMouseButton::Right,
            TerminalMousePosition::new(500, 500)
        )),
        vec![b'\x1b', b'[', b'M', 34, 255, 255]
    );
}
