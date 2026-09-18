//! Screen capture abstraction and frame streaming for Ash collaboration.

pub mod mock;

use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;

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

/// Information describing an available display target for capture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayInfo {
    pub id: String,
    pub title: String,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
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
/// Implementations provide display metadata and allow instantiating a frame stream.
pub trait ScreenCaptureSource: Send + Sync {
    /// Return display metadata.
    fn info(&self) -> &DisplayInfo;

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
