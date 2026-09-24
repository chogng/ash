use crate::input::ElementState;
use crate::input::Key;
use crate::input::KeyCode;
use crate::input::KeyEvent;
use crate::input::ModifiersState;
use crate::input::NamedKey;
use crate::input::PhysicalKey;
use crate::window::PhysicalExtent;
use crate::window::PhysicalPosition;
use crate::window::Touch;
use crate::window::TouchForce;
use crate::window::TouchPhase;
use crate::window::WindowEvent;

#[test]
fn key_event_builders_create_backend_independent_test_input() {
    let event = KeyEvent::new(Key::Character("z".to_owned()), ElementState::Pressed)
        .with_physical_key(PhysicalKey::Code(KeyCode::new("KeyZ")))
        .with_text("z")
        .repeated();

    assert_eq!(event.logical_key, Key::Character("z".to_owned()));
    assert_eq!(format!("{:?}", event.physical_key), "Code(KeyZ)");
    assert_eq!(event.text.as_deref(), Some("z"));
    assert!(event.repeat);
}

#[test]
fn modifiers_are_constructible_without_a_window_backend() {
    let modifiers = ModifiersState::default()
        .with_control()
        .with_shift()
        .with_alt()
        .with_super();

    assert!(modifiers.control_key());
    assert!(modifiers.shift_key());
    assert!(modifiers.alt_key());
    assert!(modifiers.super_key());
}

#[test]
fn native_window_events_are_normalized_before_application_dispatch() {
    let resized = WindowEvent::from_native(winit::event::WindowEvent::Resized(
        winit::dpi::PhysicalSize::new(1280, 800),
    ));
    let moved = WindowEvent::from_native(winit::event::WindowEvent::Moved(
        winit::dpi::PhysicalPosition::new(-20, 40),
    ));
    let unknown_key = NamedKey::from_native(winit::keyboard::NamedKey::AudioVolumeUp);

    assert_eq!(
        resized,
        WindowEvent::Resized(PhysicalExtent::new(1280, 800))
    );
    assert_eq!(
        moved,
        WindowEvent::Moved(PhysicalPosition::new(-20.0, 40.0))
    );
    assert_eq!(format!("{unknown_key:?}"), "AudioVolumeUp");
}

#[test]
fn native_file_drag_events_preserve_the_platform_path() {
    let path = std::path::PathBuf::from("/workspace/dropped.txt");

    assert_eq!(
        WindowEvent::from_native(winit::event::WindowEvent::HoveredFile(path.clone())),
        WindowEvent::FileHovered(path.clone())
    );
    assert_eq!(
        WindowEvent::from_native(winit::event::WindowEvent::DroppedFile(path.clone())),
        WindowEvent::FileDropped(path)
    );
    assert_eq!(
        WindowEvent::from_native(winit::event::WindowEvent::HoveredFileCancelled),
        WindowEvent::FileHoverCancelled
    );
}

#[test]
fn native_scroll_and_gesture_phases_are_preserved() {
    let device_id = winit::event::DeviceId::dummy();

    assert_eq!(
        WindowEvent::from_native(winit::event::WindowEvent::CursorEntered { device_id }),
        WindowEvent::CursorEntered
    );
    assert_eq!(
        WindowEvent::from_native(winit::event::WindowEvent::MouseWheel {
            device_id,
            delta: winit::event::MouseScrollDelta::LineDelta(1.0, -2.0),
            phase: winit::event::TouchPhase::Moved,
        }),
        WindowEvent::MouseWheel {
            delta: crate::window::MouseScrollDelta::LineDelta(1.0, -2.0),
            phase: TouchPhase::Moved,
        }
    );
    assert_eq!(
        WindowEvent::from_native(winit::event::WindowEvent::PinchGesture {
            device_id,
            delta: 0.25,
            phase: winit::event::TouchPhase::Started,
        }),
        WindowEvent::PinchGesture {
            delta: 0.25,
            phase: TouchPhase::Started,
        }
    );
    assert_eq!(
        WindowEvent::from_native(winit::event::WindowEvent::RotationGesture {
            device_id,
            delta: -15.0,
            phase: winit::event::TouchPhase::Ended,
        }),
        WindowEvent::RotationGesture {
            delta_degrees: -15.0,
            phase: TouchPhase::Ended,
        }
    );
}

#[test]
fn native_touch_pressure_and_axis_motion_are_preserved() {
    let device_id = winit::event::DeviceId::dummy();
    let touch = winit::event::Touch {
        device_id,
        phase: winit::event::TouchPhase::Started,
        location: winit::dpi::PhysicalPosition::new(12.5, 24.0),
        force: Some(winit::event::Force::Normalized(0.75)),
        id: 41,
    };

    assert_eq!(
        WindowEvent::from_native(winit::event::WindowEvent::Touch(touch)),
        WindowEvent::Touch(
            Touch::new(41, TouchPhase::Started, PhysicalPosition::new(12.5, 24.0),)
                .with_force(TouchForce::Normalized(0.75)),
        )
    );
    assert_eq!(
        WindowEvent::from_native(winit::event::WindowEvent::TouchpadPressure {
            device_id,
            pressure: 0.5,
            stage: 2,
        }),
        WindowEvent::TouchpadPressure {
            pressure: 0.5,
            stage: 2,
        }
    );
    assert_eq!(
        WindowEvent::from_native(winit::event::WindowEvent::AxisMotion {
            device_id,
            axis: 7,
            value: -0.125,
        }),
        WindowEvent::AxisMotion {
            axis: 7,
            value: -0.125,
        }
    );
}
