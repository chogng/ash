//! Screen capture abstraction, platform sources, and frame streaming for Ash collaboration.
#![deny(unsafe_code)]

pub mod mock;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as platform;

#[cfg(not(target_os = "macos"))]
mod fallback;
#[cfg(not(target_os = "macos"))]
use fallback as platform;

use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;

/// Screen capture error conditions.
#[derive(Debug, Error)]
pub enum CaptureError {
    #[error("permission denied for screen recording")]
    PermissionDenied,
    #[error("display or window not found: {0}")]
    NotFound(String),
    #[error("capture backend failed: {0}")]
    Backend(String),
    #[error("capture stream closed")]
    Closed,
}

/// Screen recording permission status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionStatus {
    Granted,
    Denied,
    NotDetermined,
}

/// Information describing an available display target for capture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayInfo {
    pub id: String,
    pub title: String,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
}

/// Information describing an available application window target for capture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub id: String,
    pub title: String,
    pub app_name: String,
    pub width: u32,
    pub height: u32,
    pub is_on_screen: bool,
}

/// Unified target descriptor for capture sources.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureTarget {
    Display(DisplayInfo),
    Window(WindowInfo),
}

/// Raw captured frame representation.
#[derive(Debug, Clone)]
pub enum CapturedFrame {
    /// 32-bit RGBA packed pixel buffer.
    Rgba {
        data: Arc<[u8]>,
        width: u32,
        height: u32,
        stride: u32,
        timestamp: Duration,
    },
}

impl CapturedFrame {
    pub fn width(&self) -> u32 {
        match self {
            Self::Rgba { width, .. } => *width,
        }
    }

    pub fn height(&self) -> u32 {
        match self {
            Self::Rgba { height, .. } => *height,
        }
    }

    pub fn timestamp(&self) -> Duration {
        match self {
            Self::Rgba { timestamp, .. } => *timestamp,
        }
    }
}

/// Trait implemented by screen capture sources.
///
/// Implementations provide display/window metadata and allow instantiating a frame stream.
pub trait ScreenCaptureSource: Send + Sync {
    /// Return display metadata or window surface metadata.
    fn info(&self) -> &DisplayInfo;

    /// Return concrete capture target kind.
    fn target(&self) -> CaptureTarget {
        CaptureTarget::Display(self.info().clone())
    }

    /// Start streaming captured frames to the provided callback.
    fn start_stream(
        &self,
        fps: u32,
        on_frame: Box<dyn Fn(CapturedFrame) + Send + Sync + 'static>,
    ) -> Result<Box<dyn ScreenCaptureStream>, CaptureError>;
}

/// Active stream handle allowing stopping the capture.
pub trait ScreenCaptureStream: Send + Sync {
    /// Stop frame capture and release resources.
    fn stop(&mut self);

    /// Check whether the stream is still active.
    fn is_active(&self) -> bool;
}

/// Check current screen capture permission status.
pub fn check_permission() -> PermissionStatus {
    platform::check_permission()
}

/// Request screen capture permission from the operating system.
/// Returns true if permission is granted.
pub fn request_permission() -> bool {
    platform::request_permission()
}

/// Enumerate active displays available for capture.
pub fn enumerate_displays() -> Result<Vec<DisplayInfo>, CaptureError> {
    platform::enumerate_displays()
}

/// Enumerate visible windows available for capture.
pub fn enumerate_windows() -> Result<Vec<WindowInfo>, CaptureError> {
    platform::enumerate_windows()
}

/// Create a screen capture source for a display ID.
pub fn create_display_source(id: &str) -> Result<Box<dyn ScreenCaptureSource>, CaptureError> {
    platform::create_display_source(id)
}

/// Create a screen capture source for a window ID.
pub fn create_window_source(id: &str) -> Result<Box<dyn ScreenCaptureSource>, CaptureError> {
    platform::create_window_source(id)
}
