use std::collections::HashMap;

use winit::event;

use crate::window::ElementState;
use crate::window::MouseScrollDelta;

use super::PhysicalKey;

/// Runtime-local identity assigned to one native input device.
///
/// The value remains stable while the device is registered with the running application. It is
/// deliberately not a persistent operating-system hardware identifier.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct DeviceId(u64);

impl DeviceId {
    /// Creates an identity for deterministic tests or custom event adapters.
    pub const fn from_raw(value: u64) -> Self {
        Self(value)
    }

    /// Returns the runtime-local numeric identity.
    pub const fn into_raw(self) -> u64 {
        self.0
    }
}

/// Raw physical keyboard input that is not associated with a focused window.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct RawKeyEvent {
    pub physical_key: PhysicalKey,
    pub state: ElementState,
}

/// Backend-independent raw input event delivered at application scope.
///
/// Unlike [`crate::window::WindowEvent`], these events are not tied to a particular native window
/// and may duplicate higher-level pointer or keyboard input.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum DeviceEvent {
    Added,
    Removed,
    MouseMotion { delta: (f64, f64) },
    MouseWheel { delta: MouseScrollDelta },
    AxisMotion { axis: u32, value: f64 },
    Button { button: u32, state: ElementState },
    Key(RawKeyEvent),
}

impl DeviceEvent {
    fn from_native(event: event::DeviceEvent) -> Self {
        match event {
            event::DeviceEvent::Added => Self::Added,
            event::DeviceEvent::Removed => Self::Removed,
            event::DeviceEvent::MouseMotion { delta } => Self::MouseMotion { delta },
            event::DeviceEvent::MouseWheel { delta } => Self::MouseWheel {
                delta: MouseScrollDelta::from_native(delta),
            },
            event::DeviceEvent::Motion { axis, value } => Self::AxisMotion { axis, value },
            event::DeviceEvent::Button { button, state } => Self::Button {
                button,
                state: ElementState::from_native(state),
            },
            event::DeviceEvent::Key(event) => Self::Key(RawKeyEvent {
                physical_key: PhysicalKey::from_native(event.physical_key),
                state: ElementState::from_native(event.state),
            }),
        }
    }
}

#[derive(Default)]
pub(crate) struct DeviceRegistry {
    next_id: u64,
    devices: HashMap<event::DeviceId, DeviceId>,
}

impl DeviceRegistry {
    pub(crate) fn normalize(
        &mut self,
        native_id: event::DeviceId,
        native_event: event::DeviceEvent,
    ) -> (DeviceId, DeviceEvent) {
        let id = if let Some(id) = self.devices.get(&native_id) {
            *id
        } else {
            self.next_id = self
                .next_id
                .checked_add(1)
                .expect("input device identity space exhausted");
            let id = DeviceId(self.next_id);
            self.devices.insert(native_id, id);
            id
        };
        let event = DeviceEvent::from_native(native_event);
        if matches!(event, DeviceEvent::Removed) {
            self.devices.remove(&native_id);
        }
        (id, event)
    }
}

#[cfg(test)]
#[path = "device_tests.rs"]
mod tests;
