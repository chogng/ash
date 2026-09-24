use ash_terminal::{
    MouseModifiers, MouseTrackingMode, ScreenBuffer, TerminalCore, TerminalMouseButton,
    TerminalMouseButtonState, TerminalMouseEvent, TerminalMousePosition,
};
use zui::input::{ElementState, ModifiersState, MouseButton, MouseScrollDelta};

#[derive(Debug, Eq, PartialEq)]
pub enum PointerInput {
    NotApplicable,
    Consumed(Vec<u8>),
}

#[derive(Default)]
pub struct TerminalPointer {
    held_button: TerminalMouseButtonState,
    last_position: Option<TerminalMousePosition>,
}

impl TerminalPointer {
    pub fn moved(
        &mut self,
        terminal: &TerminalCore,
        position: Option<TerminalMousePosition>,
        modifiers: ModifiersState,
    ) -> PointerInput {
        if !captures_pointer(terminal) {
            self.held_button = TerminalMouseButtonState::None;
            return PointerInput::NotApplicable;
        }
        let Some(position) = position else {
            return if self.held_button == TerminalMouseButtonState::None {
                PointerInput::NotApplicable
            } else {
                PointerInput::Consumed(Vec::new())
            };
        };
        self.last_position = Some(position);
        let event = TerminalMouseEvent::motion(self.held_button, position)
            .with_modifiers(mouse_modifiers(modifiers));
        PointerInput::Consumed(terminal.encode_mouse(event))
    }

    pub fn button_changed(
        &mut self,
        terminal: &TerminalCore,
        position: Option<TerminalMousePosition>,
        button: MouseButton,
        state: ElementState,
        modifiers: ModifiersState,
    ) -> PointerInput {
        let Some(button) = terminal_button(button) else {
            return PointerInput::NotApplicable;
        };
        if !captures_pointer(terminal) {
            self.held_button = TerminalMouseButtonState::None;
            return PointerInput::NotApplicable;
        }
        let event = match state {
            ElementState::Pressed => {
                let Some(position) = position else {
                    return PointerInput::NotApplicable;
                };
                self.last_position = Some(position);
                self.held_button = button_state(button);
                TerminalMouseEvent::press(button, position)
            }
            ElementState::Released => {
                let position = match position {
                    Some(position) => position,
                    None if self.held_button != TerminalMouseButtonState::None => {
                        let Some(position) = self.last_position else {
                            return PointerInput::NotApplicable;
                        };
                        position
                    }
                    None => return PointerInput::NotApplicable,
                };
                self.last_position = Some(position);
                self.held_button = TerminalMouseButtonState::None;
                TerminalMouseEvent::release(button, position)
            }
        }
        .with_modifiers(mouse_modifiers(modifiers));
        PointerInput::Consumed(terminal.encode_mouse(event))
    }

    pub fn wheel(
        &mut self,
        terminal: &TerminalCore,
        position: Option<TerminalMousePosition>,
        delta: MouseScrollDelta,
        modifiers: ModifiersState,
    ) -> PointerInput {
        if !captures_pointer(terminal) {
            self.held_button = TerminalMouseButtonState::None;
            return PointerInput::NotApplicable;
        }
        let Some(position) = position else {
            return PointerInput::NotApplicable;
        };
        let Some(button) = wheel_button(delta) else {
            return PointerInput::Consumed(Vec::new());
        };
        self.last_position = Some(position);
        let event =
            TerminalMouseEvent::press(button, position).with_modifiers(mouse_modifiers(modifiers));
        PointerInput::Consumed(terminal.encode_mouse(event))
    }

    pub fn cancel(&mut self) {
        self.held_button = TerminalMouseButtonState::None;
        self.last_position = None;
    }
}

fn captures_pointer(terminal: &TerminalCore) -> bool {
    terminal.active_screen() == ScreenBuffer::Alternate
        && terminal.modes().mouse_tracking() != MouseTrackingMode::Disabled
}

fn terminal_button(button: MouseButton) -> Option<TerminalMouseButton> {
    match button {
        MouseButton::Left => Some(TerminalMouseButton::Left),
        MouseButton::Middle => Some(TerminalMouseButton::Middle),
        MouseButton::Right => Some(TerminalMouseButton::Right),
        MouseButton::Back | MouseButton::Forward | MouseButton::Other(_) => None,
    }
}

fn button_state(button: TerminalMouseButton) -> TerminalMouseButtonState {
    match button {
        TerminalMouseButton::Left => TerminalMouseButtonState::Left,
        TerminalMouseButton::Middle => TerminalMouseButtonState::Middle,
        TerminalMouseButton::Right => TerminalMouseButtonState::Right,
        TerminalMouseButton::WheelUp | TerminalMouseButton::WheelDown => {
            TerminalMouseButtonState::None
        }
    }
}

fn wheel_button(delta: MouseScrollDelta) -> Option<TerminalMouseButton> {
    let vertical = match delta {
        MouseScrollDelta::LineDelta(_, vertical) => vertical as f64,
        MouseScrollDelta::PixelDelta(position) => position.y,
    };
    if vertical > 0.0 {
        Some(TerminalMouseButton::WheelUp)
    } else if vertical < 0.0 {
        Some(TerminalMouseButton::WheelDown)
    } else {
        None
    }
}

fn mouse_modifiers(modifiers: ModifiersState) -> MouseModifiers {
    let mut terminal = MouseModifiers::NONE;
    if modifiers.shift_key() {
        terminal = terminal.with_shift();
    }
    if modifiers.alt_key() {
        terminal = terminal.with_alt();
    }
    if modifiers.control_key() {
        terminal = terminal.with_control();
    }
    terminal
}

#[cfg(test)]
#[path = "pointer_tests.rs"]
mod tests;
