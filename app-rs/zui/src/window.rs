//! Native window configuration, identity, events, and live capabilities.

mod capability;
mod capability_error;
mod chrome;
mod display;
mod event;
mod icon;
mod native;
mod operations;
mod options;
mod parent;
mod platform;
mod policy;
mod runtime;
mod state;

pub(crate) use capability::WindowCloseMode;
pub(crate) use capability::WindowCloseRequester;
pub use capability::WindowHandle;
pub use capability_error::WindowOperationError;
pub use chrome::WindowChrome;
pub use chrome::WindowControlInsets;
pub use display::CursorPositionError;
pub use display::Display;
pub use display::DisplayEvent;
pub use display::DisplayId;
pub use display::DisplayMetricChanges;
pub use display::DisplayMode;
pub use display::DisplayRotation;
pub use display::DisplaySnapshot;
pub use event::ElementState;
pub use event::Ime;
pub use event::MouseButton;
pub use event::MouseScrollDelta;
pub use event::PhysicalPosition;
pub use event::Theme;
pub use event::Touch;
pub use event::TouchForce;
pub use event::TouchPhase;
pub use event::WindowEvent;
pub use icon::WindowIcon;
pub use icon::WindowIconError;
pub use native::CursorIcon;
pub use native::ImeCursorArea;
pub use native::LogicalPosition;
pub use native::LogicalSize;
pub use native::PhysicalExtent;
pub use native::RenderWindow;
pub use native::WindowId;
pub use native::WindowLevel;
pub use options::WindowOptions;
pub use options::WindowOptionsError;
pub use policy::CursorGrabMode;
pub use policy::ImePurpose;
pub use policy::ResizeDirection;
pub use policy::UserAttentionType;
pub use policy::WindowButtons;
pub use runtime::OpenedWindow;
pub use runtime::WindowMetrics;
pub use state::PhysicalBounds;
pub use state::WindowState;

pub(crate) use display::DisplayChangeMonitor;
pub(crate) use display::cursor_screen_position;
#[cfg(target_os = "windows")]
pub(crate) use display::is_change_message as is_display_change_message;
pub(crate) use native::NativeWindow;
pub(crate) use runtime::WindowRuntime;
pub(crate) use runtime::WindowRuntimeEnvironment;

/// Internal ownership role used to keep framework-owned utility windows out of product
/// lifecycle callbacks.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WindowRole {
    Product,
    DevTools { owner: WindowId },
}
