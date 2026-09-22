use crate::{MouseEncoding, MouseTrackingMode, TerminalModes};

/// Mouse button represented by terminal mouse reporting protocols.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalMouseButton {
    Left,
    Middle,
    Right,
    WheelUp,
    WheelDown,
}

/// Button state attached to a terminal mouse-motion event.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum TerminalMouseButtonState {
    #[default]
    None,
    Left,
    Middle,
    Right,
}

/// Zero-based character-cell position inside the active terminal grid.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalMousePosition {
    row: u16,
    col: u16,
}

impl TerminalMousePosition {
    pub const fn new(row: u16, col: u16) -> Self {
        Self { row, col }
    }

    pub const fn row(self) -> u16 {
        self.row
    }

    pub const fn col(self) -> u16 {
        self.col
    }
}

/// Keyboard modifiers included in one terminal mouse report.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct MouseModifiers(u8);

impl MouseModifiers {
    pub const NONE: Self = Self(0);
    const SHIFT: u8 = 4;
    const ALT: u8 = 8;
    const CONTROL: u8 = 16;

    pub const fn with_shift(self) -> Self {
        Self(self.0 | Self::SHIFT)
    }

    pub const fn with_alt(self) -> Self {
        Self(self.0 | Self::ALT)
    }

    pub const fn with_control(self) -> Self {
        Self(self.0 | Self::CONTROL)
    }

    const fn protocol_bits(self) -> u8 {
        self.0
    }
}

/// Semantic mouse action to be filtered and encoded by the active terminal modes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalMouseEventKind {
    Press(TerminalMouseButton),
    Release(TerminalMouseButton),
    Move(TerminalMouseButtonState),
}

/// One mouse action addressed to an active terminal cell.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalMouseEvent {
    kind: TerminalMouseEventKind,
    position: TerminalMousePosition,
    modifiers: MouseModifiers,
}

impl TerminalMouseEvent {
    pub const fn press(button: TerminalMouseButton, position: TerminalMousePosition) -> Self {
        Self {
            kind: TerminalMouseEventKind::Press(button),
            position,
            modifiers: MouseModifiers::NONE,
        }
    }

    pub const fn release(button: TerminalMouseButton, position: TerminalMousePosition) -> Self {
        Self {
            kind: TerminalMouseEventKind::Release(button),
            position,
            modifiers: MouseModifiers::NONE,
        }
    }

    pub const fn motion(button: TerminalMouseButtonState, position: TerminalMousePosition) -> Self {
        Self {
            kind: TerminalMouseEventKind::Move(button),
            position,
            modifiers: MouseModifiers::NONE,
        }
    }

    pub const fn with_modifiers(mut self, modifiers: MouseModifiers) -> Self {
        self.modifiers = modifiers;
        self
    }
}

pub(crate) fn encode_mouse(event: TerminalMouseEvent, modes: TerminalModes) -> Vec<u8> {
    if !should_report(event.kind, modes.mouse_tracking()) {
        return Vec::new();
    }
    match modes.mouse_encoding() {
        MouseEncoding::Legacy => encode_legacy(event),
        MouseEncoding::Sgr => encode_sgr(event),
    }
}

fn should_report(kind: TerminalMouseEventKind, tracking: MouseTrackingMode) -> bool {
    match (tracking, kind) {
        (MouseTrackingMode::Disabled, _) => false,
        (MouseTrackingMode::Press, TerminalMouseEventKind::Move(_)) => false,
        (
            MouseTrackingMode::ButtonEvent,
            TerminalMouseEventKind::Move(TerminalMouseButtonState::None),
        ) => false,
        (MouseTrackingMode::Press | MouseTrackingMode::ButtonEvent, _) => true,
        (MouseTrackingMode::AnyEvent, _) => true,
    }
}

fn encode_sgr(event: TerminalMouseEvent) -> Vec<u8> {
    let (button_code, final_byte) = match event.kind {
        TerminalMouseEventKind::Press(button) => (button_code(button), 'M'),
        TerminalMouseEventKind::Release(button) => (button_code(button), 'm'),
        TerminalMouseEventKind::Move(button) => (motion_button_code(button), 'M'),
    };
    let code = button_code + event.modifiers.protocol_bits();
    format!(
        "\x1b[<{code};{};{}{final_byte}",
        event.position.col as usize + 1,
        event.position.row as usize + 1
    )
    .into_bytes()
}

fn encode_legacy(event: TerminalMouseEvent) -> Vec<u8> {
    let button_code = match event.kind {
        TerminalMouseEventKind::Press(button) => button_code(button),
        TerminalMouseEventKind::Release(_) => 3,
        TerminalMouseEventKind::Move(button) => motion_button_code(button),
    } + event.modifiers.protocol_bits();
    let col = event.position.col.min(222) as u8 + 1;
    let row = event.position.row.min(222) as u8 + 1;
    vec![b'\x1b', b'[', b'M', button_code + 32, col + 32, row + 32]
}

const fn button_code(button: TerminalMouseButton) -> u8 {
    match button {
        TerminalMouseButton::Left => 0,
        TerminalMouseButton::Middle => 1,
        TerminalMouseButton::Right => 2,
        TerminalMouseButton::WheelUp => 64,
        TerminalMouseButton::WheelDown => 65,
    }
}

const fn motion_button_code(button: TerminalMouseButtonState) -> u8 {
    let button = match button {
        TerminalMouseButtonState::Left => 0,
        TerminalMouseButtonState::Middle => 1,
        TerminalMouseButtonState::Right => 2,
        TerminalMouseButtonState::None => 3,
    };
    button + 32
}

#[cfg(test)]
#[path = "mouse_tests.rs"]
mod tests;
