use winit::event;

use std::path::PathBuf;

use crate::input::KeyEvent;
use crate::input::Modifiers;
use crate::input::ModifiersState;

use super::PhysicalExtent;

/// Pressed or released state shared by keyboard and pointer input.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ElementState {
    Pressed,
    Released,
}

impl ElementState {
    pub(crate) const fn from_native(state: event::ElementState) -> Self {
        match state {
            event::ElementState::Pressed => Self::Pressed,
            event::ElementState::Released => Self::Released,
        }
    }
}

/// Physical coordinates reported by the native window system.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PhysicalPosition {
    pub x: f64,
    pub y: f64,
}

impl PhysicalPosition {
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

/// Mouse or pointing-device button identity.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
    Back,
    Forward,
    Other(u16),
}

impl MouseButton {
    pub(crate) const fn from_native(button: event::MouseButton) -> Self {
        match button {
            event::MouseButton::Left => Self::Left,
            event::MouseButton::Right => Self::Right,
            event::MouseButton::Middle => Self::Middle,
            event::MouseButton::Back => Self::Back,
            event::MouseButton::Forward => Self::Forward,
            event::MouseButton::Other(button) => Self::Other(button),
        }
    }
}

/// Scrolling distance expressed in logical lines or physical pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MouseScrollDelta {
    LineDelta(f32, f32),
    PixelDelta(PhysicalPosition),
}

/// Lifecycle phase shared by touch, scroll, and gesture input.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum TouchPhase {
    Started,
    Moved,
    Ended,
    Cancelled,
}

impl TouchPhase {
    pub(crate) const fn from_native(phase: event::TouchPhase) -> Self {
        match phase {
            event::TouchPhase::Started => Self::Started,
            event::TouchPhase::Moved => Self::Moved,
            event::TouchPhase::Ended => Self::Ended,
            event::TouchPhase::Cancelled => Self::Cancelled,
        }
    }
}

/// Pressure information attached to a touch contact.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TouchForce {
    Calibrated {
        force: f64,
        max_possible_force: f64,
        altitude_angle: Option<f64>,
    },
    Normalized(f64),
}

impl TouchForce {
    pub(crate) const fn from_native(force: event::Force) -> Self {
        match force {
            event::Force::Calibrated {
                force,
                max_possible_force,
                altitude_angle,
            } => Self::Calibrated {
                force,
                max_possible_force,
                altitude_angle,
            },
            event::Force::Normalized(force) => Self::Normalized(force),
        }
    }
}

/// One backend-independent touch contact.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Touch {
    pub id: u64,
    pub phase: TouchPhase,
    pub location: PhysicalPosition,
    pub force: Option<TouchForce>,
}

impl Touch {
    /// Creates a touch contact without optional pressure information.
    pub const fn new(id: u64, phase: TouchPhase, location: PhysicalPosition) -> Self {
        Self {
            id,
            phase,
            location,
            force: None,
        }
    }

    /// Attaches pressure information to this contact.
    pub const fn with_force(mut self, force: TouchForce) -> Self {
        self.force = Some(force);
        self
    }

    fn from_native(touch: event::Touch) -> Self {
        Self {
            id: touch.id,
            phase: TouchPhase::from_native(touch.phase),
            location: PhysicalPosition::new(touch.location.x, touch.location.y),
            force: touch.force.map(TouchForce::from_native),
        }
    }
}

impl MouseScrollDelta {
    pub(crate) fn from_native(delta: event::MouseScrollDelta) -> Self {
        match delta {
            event::MouseScrollDelta::LineDelta(x, y) => Self::LineDelta(x, y),
            event::MouseScrollDelta::PixelDelta(position) => {
                Self::PixelDelta(PhysicalPosition::new(position.x, position.y))
            }
        }
    }
}

/// Input-method lifecycle and composition text reported by the platform.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum Ime {
    Enabled,
    Preedit(String, Option<(usize, usize)>),
    Commit(String),
    Disabled,
}

impl Ime {
    pub(crate) fn from_native(event: event::Ime) -> Self {
        match event {
            event::Ime::Enabled => Self::Enabled,
            event::Ime::Preedit(text, selection) => Self::Preedit(text, selection),
            event::Ime::Commit(text) => Self::Commit(text),
            event::Ime::Disabled => Self::Disabled,
        }
    }
}

/// System light or dark appearance for a native window.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Theme {
    Light,
    Dark,
}

impl Theme {
    pub(crate) const fn from_native(theme: winit::window::Theme) -> Self {
        match theme {
            winit::window::Theme::Light => Self::Light,
            winit::window::Theme::Dark => Self::Dark,
        }
    }

    pub(crate) const fn into_native(self) -> winit::window::Theme {
        match self {
            Self::Light => winit::window::Theme::Light,
            Self::Dark => winit::window::Theme::Dark,
        }
    }
}

/// Backend-independent window event delivered by [`crate::app::App`].
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum WindowEvent {
    /// A platform startup-notification token became available.
    ActivationToken(String),
    CloseRequested,
    Destroyed,
    Moved(PhysicalPosition),
    Resized(PhysicalExtent),
    ScaleFactorChanged {
        scale_factor: f64,
    },
    ThemeChanged(Theme),
    CursorMoved {
        position: PhysicalPosition,
    },
    CursorEntered,
    CursorLeft,
    ModifiersChanged(Modifiers),
    KeyboardInput {
        event: KeyEvent,
        synthetic: bool,
    },
    Ime(Ime),
    Focused(bool),
    MouseInput {
        state: ElementState,
        button: MouseButton,
    },
    MouseWheel {
        delta: MouseScrollDelta,
        phase: TouchPhase,
    },
    PinchGesture {
        delta: f64,
        phase: TouchPhase,
    },
    PanGesture {
        delta: PhysicalPosition,
        phase: TouchPhase,
    },
    DoubleTapGesture,
    RotationGesture {
        delta_degrees: f32,
        phase: TouchPhase,
    },
    TouchpadPressure {
        pressure: f32,
        stage: i64,
    },
    AxisMotion {
        axis: u32,
        value: f64,
    },
    Touch(Touch),
    FileHovered(PathBuf),
    FileHoverCancelled,
    FileDropped(PathBuf),
    Occluded(bool),
    RedrawRequested,
}

impl WindowEvent {
    pub(crate) fn from_native(event: event::WindowEvent) -> Self {
        match event {
            event::WindowEvent::ActivationTokenDone { token, .. } => {
                Self::ActivationToken(token.into_raw())
            }
            event::WindowEvent::CloseRequested => Self::CloseRequested,
            event::WindowEvent::Destroyed => Self::Destroyed,
            event::WindowEvent::Moved(position) => {
                Self::Moved(PhysicalPosition::new(position.x.into(), position.y.into()))
            }
            event::WindowEvent::Resized(size) => {
                Self::Resized(PhysicalExtent::new(size.width, size.height))
            }
            event::WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                Self::ScaleFactorChanged { scale_factor }
            }
            event::WindowEvent::ThemeChanged(theme) => {
                Self::ThemeChanged(Theme::from_native(theme))
            }
            event::WindowEvent::CursorMoved { position, .. } => Self::CursorMoved {
                position: PhysicalPosition::new(position.x, position.y),
            },
            event::WindowEvent::CursorEntered { .. } => Self::CursorEntered,
            event::WindowEvent::CursorLeft { .. } => Self::CursorLeft,
            event::WindowEvent::ModifiersChanged(modifiers) => Self::ModifiersChanged(
                Modifiers::new(ModifiersState::from_native(modifiers.state())),
            ),
            event::WindowEvent::KeyboardInput {
                event,
                is_synthetic,
                ..
            } => Self::KeyboardInput {
                event: KeyEvent::from_native(event),
                synthetic: is_synthetic,
            },
            event::WindowEvent::Ime(event) => Self::Ime(Ime::from_native(event)),
            event::WindowEvent::Focused(focused) => Self::Focused(focused),
            event::WindowEvent::MouseInput { state, button, .. } => Self::MouseInput {
                state: ElementState::from_native(state),
                button: MouseButton::from_native(button),
            },
            event::WindowEvent::MouseWheel { delta, phase, .. } => Self::MouseWheel {
                delta: MouseScrollDelta::from_native(delta),
                phase: TouchPhase::from_native(phase),
            },
            event::WindowEvent::PinchGesture { delta, phase, .. } => Self::PinchGesture {
                delta,
                phase: TouchPhase::from_native(phase),
            },
            event::WindowEvent::PanGesture { delta, phase, .. } => Self::PanGesture {
                delta: PhysicalPosition::new(delta.x.into(), delta.y.into()),
                phase: TouchPhase::from_native(phase),
            },
            event::WindowEvent::DoubleTapGesture { .. } => Self::DoubleTapGesture,
            event::WindowEvent::RotationGesture { delta, phase, .. } => Self::RotationGesture {
                delta_degrees: delta,
                phase: TouchPhase::from_native(phase),
            },
            event::WindowEvent::TouchpadPressure {
                pressure, stage, ..
            } => Self::TouchpadPressure { pressure, stage },
            event::WindowEvent::AxisMotion { axis, value, .. } => Self::AxisMotion { axis, value },
            event::WindowEvent::Touch(touch) => Self::Touch(Touch::from_native(touch)),
            event::WindowEvent::HoveredFile(path) => Self::FileHovered(path),
            event::WindowEvent::HoveredFileCancelled => Self::FileHoverCancelled,
            event::WindowEvent::DroppedFile(path) => Self::FileDropped(path),
            event::WindowEvent::Occluded(occluded) => Self::Occluded(occluded),
            event::WindowEvent::RedrawRequested => Self::RedrawRequested,
        }
    }
}

#[cfg(test)]
#[path = "event_tests.rs"]
mod tests;
