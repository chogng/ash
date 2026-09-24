//! Common imports for a minimal ZUI application.

pub use crate::ui::Color;
pub use crate::ui::Element;
pub use crate::ui::Point;
pub use crate::ui::Rect;
pub use crate::ui::Size;
pub use crate::ui::UiScene;

#[cfg(feature = "native")]
pub use crate::app::App;
#[cfg(feature = "native")]
pub use crate::app::AppContext;
#[cfg(feature = "native")]
pub use crate::app::Application;
#[cfg(feature = "native")]
pub use crate::app::WindowContext;
#[cfg(feature = "native")]
pub use crate::window::WindowEvent;
#[cfg(feature = "native")]
pub use crate::window::WindowOptions;
