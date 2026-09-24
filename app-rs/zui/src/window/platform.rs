use winit::error::ExternalError;
use winit::window::Window;
use winit::window::WindowAttributes;

use super::WindowId;
use super::WindowOperationError;

#[cfg(target_os = "linux")]
pub(super) fn apply_desktop_application_id(
    attributes: WindowAttributes,
    desktop_application_id: Option<&str>,
) -> WindowAttributes {
    let Some(application_id) = desktop_application_id else {
        return attributes;
    };
    let attributes = winit::platform::wayland::WindowAttributesExtWayland::with_name(
        attributes,
        application_id,
        application_id,
    );
    winit::platform::x11::WindowAttributesExtX11::with_name(
        attributes,
        application_id,
        application_id,
    )
}

#[cfg(not(target_os = "linux"))]
pub(super) fn apply_desktop_application_id(
    attributes: WindowAttributes,
    _desktop_application_id: Option<&str>,
) -> WindowAttributes {
    attributes
}

pub(super) fn programmatic_position_supported(window: &Window) -> bool {
    !is_wayland(window)
}

pub(super) fn window_level_supported(window: &Window) -> bool {
    !is_wayland(window)
}

pub(super) fn visibility_supported(window: &Window) -> bool {
    !is_wayland(window)
}

pub(super) fn focus_supported(window: &Window) -> bool {
    !is_wayland(window)
}

pub(super) fn minimized_restore_supported(window: &Window) -> bool {
    !is_wayland(window)
}

#[cfg(target_os = "linux")]
pub(super) fn dynamic_transparency_supported(window: &Window) -> bool {
    is_wayland(window)
}

#[cfg(not(target_os = "linux"))]
pub(super) fn dynamic_transparency_supported(_window: &Window) -> bool {
    true
}

#[cfg(target_os = "macos")]
pub(super) fn blur_supported(_window: &Window) -> bool {
    true
}

#[cfg(target_os = "linux")]
pub(super) fn blur_supported(window: &Window) -> bool {
    is_wayland(window)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(super) fn blur_supported(_window: &Window) -> bool {
    false
}

#[cfg(target_os = "windows")]
pub(super) fn window_icon_supported(_window: &Window) -> bool {
    true
}

#[cfg(target_os = "linux")]
pub(super) fn window_icon_supported(window: &Window) -> bool {
    !is_wayland(window)
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
pub(super) fn window_icon_supported(_window: &Window) -> bool {
    false
}

#[cfg(target_os = "linux")]
pub(super) fn ime_purpose_supported(window: &Window) -> bool {
    is_wayland(window)
}

#[cfg(not(target_os = "linux"))]
pub(super) fn ime_purpose_supported(_window: &Window) -> bool {
    false
}

pub(super) fn map_external_error(
    window: WindowId,
    operation: &'static str,
    source: ExternalError,
) -> WindowOperationError {
    match source {
        ExternalError::NotSupported(_) => WindowOperationError::Unsupported { window, operation },
        source => WindowOperationError::Platform {
            window,
            operation,
            source: Box::new(source),
        },
    }
}

#[cfg(target_os = "linux")]
fn is_wayland(window: &Window) -> bool {
    use winit::platform::wayland::WindowExtWayland;

    window.xdg_toplevel().is_some()
}

#[cfg(not(target_os = "linux"))]
fn is_wayland(window: &Window) -> bool {
    let _ = window;
    false
}
