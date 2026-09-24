use crate::window::CursorIcon;
use crate::window::LogicalPosition;
use crate::window::LogicalSize;
use crate::window::Theme;
use crate::window::WindowButtons;
use crate::window::WindowChrome;
use crate::window::WindowIcon;
use crate::window::WindowId;
use crate::window::WindowLevel;
use thiserror::Error;

/// Invalid policy supplied while configuring a native window.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum WindowOptionsError {
    /// One configured size was non-finite, zero, or negative.
    #[error("{field} must contain finite, positive dimensions")]
    InvalidSize { field: &'static str },
    /// The requested initial screen coordinates were not finite.
    #[error("initial window position must contain finite coordinates")]
    InvalidPosition,
    /// The minimum size exceeded the maximum along at least one axis.
    #[error("minimum inner size must not exceed maximum inner size")]
    InvalidSizeRange,
    /// A requested parent is not a live product window in this application runtime.
    #[error("parent window {} is not a live product window", parent.into_raw())]
    ParentNotFound { parent: WindowId },
    /// Internal configuration attempted to mark a parentless window as modal.
    #[error("a modal window requires a live parent window")]
    ModalRequiresParent,
    /// The selected native backend cannot represent one requested capability.
    #[error("{capability} is unsupported by the selected native backend")]
    Unsupported { capability: &'static str },
}

/// Native window creation policy supplied by an application.
#[derive(Debug)]
pub struct WindowOptions {
    pub(crate) title: String,
    pub(crate) inner_size: Option<LogicalSize>,
    pub(crate) min_inner_size: Option<LogicalSize>,
    pub(crate) max_inner_size: Option<LogicalSize>,
    pub(crate) resize_increments: Option<LogicalSize>,
    pub(crate) position: Option<LogicalPosition>,
    pub(crate) chrome: WindowChrome,
    pub(crate) visible: bool,
    pub(crate) active: bool,
    pub(crate) resizable: bool,
    pub(crate) maximized: bool,
    pub(crate) fullscreen: bool,
    pub(crate) window_level: WindowLevel,
    pub(crate) enabled_buttons: WindowButtons,
    pub(crate) preferred_theme: Option<Theme>,
    pub(crate) content_protected: bool,
    pub(crate) cursor: CursorIcon,
    pub(crate) transparent: bool,
    pub(crate) blur: bool,
    pub(crate) icon: Option<WindowIcon>,
    pub(crate) parent: Option<WindowId>,
    pub(crate) modal: bool,
}

impl WindowOptions {
    /// Creates a native window request with platform chrome and the supplied title.
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            inner_size: None,
            min_inner_size: None,
            max_inner_size: None,
            resize_increments: None,
            position: None,
            chrome: WindowChrome::Native,
            visible: true,
            active: true,
            resizable: true,
            maximized: false,
            fullscreen: false,
            window_level: WindowLevel::Normal,
            enabled_buttons: WindowButtons::ALL,
            preferred_theme: None,
            content_protected: false,
            cursor: CursorIcon::Default,
            transparent: false,
            blur: false,
            icon: None,
            parent: None,
            modal: false,
        }
    }

    /// Replaces the title shown by the native window system.
    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.title = title.into();
        self
    }

    /// Selects the relationship between native chrome and product content.
    pub const fn with_chrome(mut self, chrome: WindowChrome) -> Self {
        self.chrome = chrome;
        self
    }

    /// Sets the requested logical inner size.
    pub const fn with_inner_size(mut self, size: LogicalSize) -> Self {
        self.inner_size = Some(size);
        self
    }

    /// Sets the minimum logical content size accepted by the platform.
    pub const fn with_min_inner_size(mut self, size: LogicalSize) -> Self {
        self.min_inner_size = Some(size);
        self
    }

    /// Sets the maximum logical content size accepted by the platform.
    pub const fn with_max_inner_size(mut self, size: LogicalSize) -> Self {
        self.max_inner_size = Some(size);
        self
    }

    /// Sets the logical step used for user-driven window resizing.
    pub const fn with_resize_increments(mut self, increments: LogicalSize) -> Self {
        self.resize_increments = Some(increments);
        self
    }

    /// Sets the requested initial logical screen position.
    pub const fn with_position(mut self, position: LogicalPosition) -> Self {
        self.position = Some(position);
        self
    }

    /// Selects whether the window is shown after renderer and accessibility setup completes.
    pub const fn with_visible(mut self, visible: bool) -> Self {
        self.visible = visible;
        self
    }

    /// Selects whether opening the window should request platform activation.
    pub const fn with_active(mut self, active: bool) -> Self {
        self.active = active;
        self
    }

    /// Selects whether the user can resize the window.
    pub const fn with_resizable(mut self, resizable: bool) -> Self {
        self.resizable = resizable;
        self
    }

    /// Selects whether the window opens maximized.
    pub const fn with_maximized(mut self, maximized: bool) -> Self {
        self.maximized = maximized;
        self
    }

    /// Selects whether the window opens in borderless fullscreen mode.
    pub const fn with_fullscreen(mut self, fullscreen: bool) -> Self {
        self.fullscreen = fullscreen;
        self
    }

    /// Selects the native stacking level requested for this window.
    pub const fn with_window_level(mut self, window_level: WindowLevel) -> Self {
        self.window_level = window_level;
        self
    }

    /// Selects which standard native titlebar buttons remain enabled.
    pub const fn with_enabled_buttons(mut self, buttons: WindowButtons) -> Self {
        self.enabled_buttons = buttons;
        self
    }

    /// Overrides the system light or dark preference for this window.
    pub const fn with_theme(mut self, theme: Option<Theme>) -> Self {
        self.preferred_theme = theme;
        self
    }

    /// Requests operating-system protection against external window capture.
    pub const fn with_content_protected(mut self, protected: bool) -> Self {
        self.content_protected = protected;
        self
    }

    /// Selects the pointer cursor installed when the native window is created.
    pub const fn with_cursor(mut self, cursor: CursorIcon) -> Self {
        self.cursor = cursor;
        self
    }

    /// Selects whether renderer alpha can make the native window transparent.
    ///
    /// Disabling transparency also disables any previously requested background blur.
    pub const fn with_transparent(mut self, transparent: bool) -> Self {
        self.transparent = transparent;
        if !transparent {
            self.blur = false;
        }
        self
    }

    /// Requests compositor blur behind transparent content where supported.
    ///
    /// Enabling blur also enables window transparency.
    pub const fn with_blur(mut self, blur: bool) -> Self {
        self.blur = blur;
        if blur {
            self.transparent = true;
        }
        self
    }

    /// Installs validated native titlebar/task-switcher artwork where supported.
    pub fn with_icon(mut self, icon: WindowIcon) -> Self {
        self.icon = Some(icon);
        self
    }

    /// Makes this an owned child of a live product window.
    pub const fn with_parent(mut self, parent: WindowId) -> Self {
        self.parent = Some(parent);
        self.modal = false;
        self
    }

    /// Makes this a modal child whose owner cannot receive input until all modal children close.
    pub const fn with_modal_parent(mut self, parent: WindowId) -> Self {
        self.parent = Some(parent);
        self.modal = true;
        self
    }

    /// Returns the configured parent identity, if any.
    pub const fn parent(&self) -> Option<WindowId> {
        self.parent
    }

    /// Returns whether this request is configured as a modal child.
    pub const fn is_modal(&self) -> bool {
        self.modal
    }

    /// Validates backend-independent invariants before native resources are allocated.
    pub fn validate(&self) -> Result<(), WindowOptionsError> {
        for (field, size) in [
            ("inner size", self.inner_size),
            ("minimum inner size", self.min_inner_size),
            ("maximum inner size", self.max_inner_size),
            ("resize increments", self.resize_increments),
        ] {
            if size.is_some_and(|size| !size.is_valid()) {
                return Err(WindowOptionsError::InvalidSize { field });
            }
        }
        if let (Some(min), Some(max)) = (self.min_inner_size, self.max_inner_size)
            && (min.width > max.width || min.height > max.height)
        {
            return Err(WindowOptionsError::InvalidSizeRange);
        }
        if self.position.is_some_and(|position| !position.is_valid()) {
            return Err(WindowOptionsError::InvalidPosition);
        }
        if self.modal && self.parent.is_none() {
            return Err(WindowOptionsError::ModalRequiresParent);
        }
        Ok(())
    }
}
