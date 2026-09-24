use winit::window::Window;

use super::LogicalSize;
use super::PhysicalExtent;
use super::PhysicalPosition;
use super::Theme;
use super::WindowButtons;

/// Physical outer-window bounds reported by the native window manager.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PhysicalBounds {
    position: PhysicalPosition,
    extent: PhysicalExtent,
}

impl PhysicalBounds {
    /// Creates explicit physical outer bounds.
    pub const fn new(position: PhysicalPosition, extent: PhysicalExtent) -> Self {
        Self { position, extent }
    }

    /// Returns the outer window's top-left screen position.
    pub const fn position(self) -> PhysicalPosition {
        self.position
    }

    /// Returns the outer window's physical extent, including native chrome.
    pub const fn extent(self) -> PhysicalExtent {
        self.extent
    }
}

/// Queryable platform state captured from one live native window.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WindowState {
    physical_extent: PhysicalExtent,
    logical_size: LogicalSize,
    outer_position: Option<PhysicalPosition>,
    outer_extent: PhysicalExtent,
    scale_factor: f64,
    visible: Option<bool>,
    focused: bool,
    minimized: Option<bool>,
    maximized: bool,
    fullscreen: bool,
    resizable: bool,
    resize_increments: Option<PhysicalExtent>,
    enabled_buttons: WindowButtons,
    decorated: bool,
    theme: Option<Theme>,
}

impl WindowState {
    pub(crate) fn from_native(window: &Window) -> Self {
        let extent = window.inner_size();
        let outer_extent = window.outer_size();
        let scale_factor = window.scale_factor();
        let scale_factor = if scale_factor.is_finite() && scale_factor > 0.0 {
            scale_factor
        } else {
            1.0
        };
        Self {
            physical_extent: PhysicalExtent::new(extent.width, extent.height),
            logical_size: LogicalSize::new(
                f64::from(extent.width) / scale_factor,
                f64::from(extent.height) / scale_factor,
            ),
            outer_position: window.outer_position().ok().map(|position| {
                PhysicalPosition::new(f64::from(position.x), f64::from(position.y))
            }),
            outer_extent: PhysicalExtent::new(outer_extent.width, outer_extent.height),
            scale_factor,
            visible: window.is_visible(),
            focused: window.has_focus(),
            minimized: window.is_minimized(),
            maximized: window.is_maximized(),
            fullscreen: window.fullscreen().is_some(),
            resizable: window.is_resizable(),
            resize_increments: window
                .resize_increments()
                .map(|size| PhysicalExtent::new(size.width, size.height)),
            enabled_buttons: WindowButtons::from_native(window.enabled_buttons()),
            decorated: window.is_decorated(),
            theme: window.theme().map(Theme::from_native),
        }
    }

    /// Returns the current physical content extent.
    pub const fn physical_extent(self) -> PhysicalExtent {
        self.physical_extent
    }

    /// Returns the current logical content size.
    pub const fn logical_size(self) -> LogicalSize {
        self.logical_size
    }

    /// Returns the outer top-left screen position when the backend can report it.
    pub const fn outer_position(self) -> Option<PhysicalPosition> {
        self.outer_position
    }

    /// Returns the outer physical extent, including native chrome.
    pub const fn outer_extent(self) -> PhysicalExtent {
        self.outer_extent
    }

    /// Returns complete outer bounds when the backend can report global screen coordinates.
    pub const fn outer_bounds(self) -> Option<PhysicalBounds> {
        match self.outer_position {
            Some(position) => Some(PhysicalBounds::new(position, self.outer_extent)),
            None => None,
        }
    }

    /// Returns the validated logical-to-physical scale factor.
    pub const fn scale_factor(self) -> f64 {
        self.scale_factor
    }

    /// Returns platform visibility when the backend can report it.
    pub const fn visible(self) -> Option<bool> {
        self.visible
    }

    /// Returns whether the window currently owns keyboard focus.
    pub const fn focused(self) -> bool {
        self.focused
    }

    /// Returns platform minimization state when the backend can report it.
    pub const fn minimized(self) -> Option<bool> {
        self.minimized
    }

    /// Returns whether the platform currently reports the window as maximized.
    pub const fn maximized(self) -> bool {
        self.maximized
    }

    /// Returns whether the window currently occupies a fullscreen space.
    pub const fn fullscreen(self) -> bool {
        self.fullscreen
    }

    /// Returns whether the user can resize the window.
    pub const fn resizable(self) -> bool {
        self.resizable
    }

    /// Returns the effective physical resize increments when configured and reportable.
    pub const fn resize_increments(self) -> Option<PhysicalExtent> {
        self.resize_increments
    }

    /// Returns the native titlebar buttons currently reported as enabled.
    pub const fn enabled_buttons(self) -> WindowButtons {
        self.enabled_buttons
    }

    /// Returns whether native window decorations are currently enabled.
    pub const fn decorated(self) -> bool {
        self.decorated
    }

    /// Returns the current platform appearance preference when available.
    pub const fn theme(self) -> Option<Theme> {
        self.theme
    }
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
