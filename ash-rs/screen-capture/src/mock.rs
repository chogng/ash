//! Deterministic screen capture mock source for headless CI and tests.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::task::JoinHandle;

use crate::CaptureError;
use crate::CapturedFrame;
use crate::DisplayInfo;
use crate::ScreenCaptureSource;
use crate::ScreenCaptureStream;

/// Deterministic mock capture source generating solid test frames.
pub struct MockCaptureSource {
    info: DisplayInfo,
}

impl MockCaptureSource {
    pub fn new(id: impl Into<String>, width: u32, height: u32) -> Self {
        Self {
            info: DisplayInfo {
                id: id.into(),
                title: "Mock Virtual Display".to_string(),
                width,
                height,
                is_primary: true,
            },
        }
    }
}

impl ScreenCaptureSource for MockCaptureSource {
    fn info(&self) -> &DisplayInfo {
        &self.info
    }

    fn start_stream(
        &self,
        fps: u32,
        on_frame: Box<dyn Fn(CapturedFrame) + Send + Sync + 'static>,
    ) -> Result<Box<dyn ScreenCaptureStream>, CaptureError> {
        let fps = fps.clamp(1, 60);
        let interval = Duration::from_secs_f64(1.0 / fps as f64);
        let active = Arc::new(AtomicBool::new(true));
        let active_clone = Arc::clone(&active);
        let width = self.info.width;
        let height = self.info.height;

        let handle = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            let mut frame_index: u64 = 0;
            let stride = width * 4;
            let buffer_len = (stride * height) as usize;

            while active_clone.load(Ordering::Relaxed) {
                ticker.tick().await;
                if !active_clone.load(Ordering::Relaxed) {
                    break;
                }

                let color_val = (frame_index % 255) as u8;
                let data = vec![color_val; buffer_len].into_boxed_slice();

                let frame = CapturedFrame::Rgba {
                    data: Arc::from(data),
                    width,
                    height,
                    stride,
                    timestamp: Duration::from_millis(frame_index * (1000 / fps as u64)),
                };

                on_frame(frame);
                frame_index = frame_index.wrapping_add(1);
            }
        });

        Ok(Box::new(MockCaptureStream {
            active,
            task: Some(handle),
        }))
    }
}

/// Active mock stream handle managing the background generation task.
pub struct MockCaptureStream {
    active: Arc<AtomicBool>,
    task: Option<JoinHandle<()>>,
}

impl ScreenCaptureStream for MockCaptureStream {
    fn error(&self) -> Option<String> {
        None
    }
    fn stop(&mut self) {
        if self.active.swap(false, Ordering::SeqCst) {
            if let Some(task) = self.task.take() {
                task.abort();
            }
        }
    }

    fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }
}

impl Drop for MockCaptureStream {
    fn drop(&mut self) {
        self.stop();
    }
}
