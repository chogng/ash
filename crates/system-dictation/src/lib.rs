//! Operating-system dictation, independent of chat and voice models.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::thread::JoinHandle;

#[derive(Debug)]
pub enum DictationError {
    Unsupported,
    System(String),
}

impl std::fmt::Display for DictationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported => {
                formatter.write_str("system dictation is unavailable on this platform")
            }
            Self::System(detail) => write!(formatter, "system dictation failed: {detail}"),
        }
    }
}

impl std::error::Error for DictationError {}

pub enum DictationEvent {
    Transcript(String),
    Failed(String),
    Ended,
}

/// Owns a single operating-system recognition session and releases the microphone on drop.
pub struct DictationSession {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl DictationSession {
    pub fn start(
        on_event: impl Fn(DictationEvent) + Send + 'static,
    ) -> Result<Self, DictationError> {
        #[cfg(windows)]
        {
            let stop = Arc::new(AtomicBool::new(false));
            let worker = windows::start(stop.clone(), on_event)?;
            Ok(Self {
                stop,
                worker: Some(worker),
            })
        }
        #[cfg(not(windows))]
        {
            let _ = on_event;
            Err(DictationError::Unsupported)
        }
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for DictationSession {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(windows)]
mod windows;
