use winit::window::WindowAttributes;

#[cfg(target_os = "macos")]
// When a first-party window host replaces winit, it should measure the native controls and supply
// that geometry through `WindowControlInsets`; this policy value is the host datum we need.
const MACOS_WINDOW_CONTROLS_WIDTH: f32 = 70.0;

/// Logical horizontal space occupied by native controls over product-drawn window content.
///
/// Product titlebars use these insets to keep interactive content outside system-owned close,
/// minimize, maximize, and fullscreen controls. Values describe the selected platform chrome
/// policy rather than a product styling preference; components remain responsible for their own
/// visual gap. A future first-party window host must provide this same logical left/right geometry
/// from its native controls, allowing product layout to remain independent of the host backend.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct WindowControlInsets {
    left: f32,
    right: f32,
}

impl WindowControlInsets {
    /// No native controls overlap the product content.
    pub const NONE: Self = Self {
        left: 0.0,
        right: 0.0,
    };

    /// Creates insets from logical left and right occupied widths.
    pub fn from_logical_sides(left: f32, right: f32) -> Self {
        Self {
            left: normalized_inset(left),
            right: normalized_inset(right),
        }
    }

    /// Returns the logical width occupied along the left window edge.
    pub const fn left(self) -> f32 {
        self.left
    }

    /// Returns the logical width occupied along the right window edge.
    pub const fn right(self) -> f32 {
        self.right
    }
}

/// Selects how native window chrome and product-drawn content share the top window region.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum WindowChrome {
    /// Keeps the platform's standard titlebar and content layout.
    #[default]
    Native,
    /// Extends product content beneath a transparent macOS titlebar while retaining system window
    /// buttons and window-management behavior.
    ContentUnderTitlebar,
}

/// Applies a named chrome policy without exposing platform extension traits to product hosts.
pub(crate) fn apply_window_chrome(
    attributes: WindowAttributes,
    chrome: WindowChrome,
) -> WindowAttributes {
    match chrome {
        WindowChrome::Native => attributes,
        WindowChrome::ContentUnderTitlebar => content_under_titlebar(attributes),
    }
}

pub(crate) fn window_control_insets(chrome: WindowChrome) -> WindowControlInsets {
    if chrome != WindowChrome::ContentUnderTitlebar {
        return WindowControlInsets::NONE;
    }
    platform_window_control_insets()
}

#[cfg(target_os = "macos")]
fn content_under_titlebar(attributes: WindowAttributes) -> WindowAttributes {
    use winit::platform::macos::WindowAttributesExtMacOS;

    attributes
        .with_titlebar_transparent(true)
        .with_title_hidden(true)
        .with_fullsize_content_view(true)
        .with_accepts_first_mouse(true)
}

#[cfg(not(target_os = "macos"))]
fn content_under_titlebar(attributes: WindowAttributes) -> WindowAttributes {
    attributes
}

#[cfg(target_os = "macos")]
fn platform_window_control_insets() -> WindowControlInsets {
    WindowControlInsets::from_logical_sides(MACOS_WINDOW_CONTROLS_WIDTH, 0.0)
}

#[cfg(not(target_os = "macos"))]
fn platform_window_control_insets() -> WindowControlInsets {
    WindowControlInsets::NONE
}

fn normalized_inset(value: f32) -> f32 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

#[cfg(test)]
#[path = "chrome_tests.rs"]
mod tests;
