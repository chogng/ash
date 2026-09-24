use winit::event;
use winit::keyboard;

use super::DeviceEvent;
use super::DeviceRegistry;
use super::RawKeyEvent;
use crate::input::KeyCode;
use crate::input::PhysicalKey;
use crate::window::ElementState;
use crate::window::MouseScrollDelta;

#[test]
fn raw_device_events_are_exhaustively_normalized() {
    let mut registry = DeviceRegistry::default();
    let native_id = event::DeviceId::dummy();

    let (id, added) = registry.normalize(native_id, event::DeviceEvent::Added);
    assert_eq!(id.into_raw(), 1);
    assert_eq!(added, DeviceEvent::Added);

    let (same_id, wheel) = registry.normalize(
        native_id,
        event::DeviceEvent::MouseWheel {
            delta: event::MouseScrollDelta::LineDelta(1.5, -2.0),
        },
    );
    assert_eq!(same_id, id);
    assert_eq!(
        wheel,
        DeviceEvent::MouseWheel {
            delta: MouseScrollDelta::LineDelta(1.5, -2.0),
        }
    );

    let (_, key) = registry.normalize(
        native_id,
        event::DeviceEvent::Key(event::RawKeyEvent {
            physical_key: keyboard::PhysicalKey::Code(keyboard::KeyCode::KeyA),
            state: event::ElementState::Pressed,
        }),
    );
    assert_eq!(
        key,
        DeviceEvent::Key(RawKeyEvent {
            physical_key: PhysicalKey::Code(KeyCode::new("KeyA")),
            state: ElementState::Pressed,
        })
    );
}

#[test]
fn removing_and_readding_a_native_device_allocates_a_new_identity() {
    let mut registry = DeviceRegistry::default();
    let native_id = event::DeviceId::dummy();
    let (first, _) = registry.normalize(native_id, event::DeviceEvent::Added);
    let (removed, event) = registry.normalize(native_id, event::DeviceEvent::Removed);
    let (second, _) = registry.normalize(native_id, event::DeviceEvent::Added);

    assert_eq!(removed, first);
    assert_eq!(event, DeviceEvent::Removed);
    assert_ne!(second, first);
}
