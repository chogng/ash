use crate::CaptureError;
use crate::DisplayInfo;
use crate::PermissionStatus;
use crate::ScreenCaptureSource;
use crate::WindowInfo;

pub fn check_permission() -> PermissionStatus {
    PermissionStatus::NotDetermined
}

pub fn request_permission() -> bool {
    false
}

pub fn enumerate_displays() -> Result<Vec<DisplayInfo>, CaptureError> {
    Err(CaptureError::Backend(
        "display capture is not supported on this platform".to_string(),
    ))
}

pub fn enumerate_windows() -> Result<Vec<WindowInfo>, CaptureError> {
    Err(CaptureError::Backend(
        "window capture is not supported on this platform".to_string(),
    ))
}

pub fn create_display_source(_id: &str) -> Result<Box<dyn ScreenCaptureSource>, CaptureError> {
    Err(CaptureError::Backend(
        "display capture is not supported on this platform".to_string(),
    ))
}

pub fn create_window_source(_id: &str) -> Result<Box<dyn ScreenCaptureSource>, CaptureError> {
    Err(CaptureError::Backend(
        "window capture is not supported on this platform".to_string(),
    ))
}
