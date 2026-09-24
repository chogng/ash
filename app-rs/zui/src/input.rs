//! Normalized keyboard, pointer, and input-method contracts.

mod device;
mod keyboard;

pub use crate::window::ElementState;
pub use crate::window::Ime;
pub use crate::window::MouseButton;
pub use crate::window::MouseScrollDelta;
pub use crate::window::PhysicalPosition;
pub use crate::window::Touch;
pub use crate::window::TouchForce;
pub use crate::window::TouchPhase;
pub use device::DeviceEvent;
pub use device::DeviceId;
pub(crate) use device::DeviceRegistry;
pub use device::RawKeyEvent;
pub use keyboard::Key;
pub use keyboard::KeyCode;
pub use keyboard::KeyEvent;
pub use keyboard::Modifiers;
pub use keyboard::ModifiersState;
pub use keyboard::NamedKey;
pub use keyboard::PhysicalKey;
