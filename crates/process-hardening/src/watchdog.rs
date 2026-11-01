//! Progress enforcement independent of the runtime or locks being monitored.

use std::io;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use std::time::Instant;

/// Bounds a process owner's unresponsive loop and destructors using an independent OS thread.
/// Declare before owned services so their shutdown remains covered until the last owner drops.
pub struct ProcessWatchdog {
    progress: Arc<AtomicU64>,
    stop: mpsc::Sender<()>,
    worker: Option<thread::JoinHandle<()>>,
}

impl ProcessWatchdog {
    pub fn start(timeout: Duration) -> io::Result<Self> {
        if timeout.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "zero watchdog timeout",
            ));
        }
        let progress = Arc::new(AtomicU64::new(0));
        let observed = Arc::clone(&progress);
        let (stop, receiver) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("ash-process-watchdog".into())
            .spawn(move || {
                let interval = (timeout / 4)
                    .min(Duration::from_millis(250))
                    .max(Duration::from_millis(1));
                let mut last_check = Instant::now();
                let mut last_progress = last_check;
                let mut previous = 0;
                loop {
                    match receiver.recv_timeout(interval) {
                        Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                    let now = Instant::now();
                    let current = observed.load(Ordering::Acquire);
                    // Suspending the process or machine stalls both the owner and this
                    // thread. Resume with a new budget instead of treating sleep as a hang.
                    if current != previous || now.duration_since(last_check) >= timeout {
                        last_progress = now;
                    }
                    previous = current;
                    last_check = now;
                    if now.duration_since(last_progress) >= timeout {
                        // Exit hooks and Rust destructors can hold the same stalled locks.
                        // Owned Unix session guards / Windows Jobs reclaim children after
                        // the kernel closes this process's lifelines and handles.
                        force_exit();
                    }
                }
            })?;
        Ok(Self {
            progress,
            stop,
            worker: Some(worker),
        })
    }

    /// Call from the actual owner loop, never from an unrelated timer task.
    pub fn tick(&self) {
        self.progress.fetch_add(1, Ordering::Release);
    }
}

impl Drop for ProcessWatchdog {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(unix)]
fn force_exit() -> ! {
    // SAFETY: no arguments or resources are accessed after terminating this process.
    unsafe {
        libc::_exit(1);
    }
}

#[cfg(test)]
#[path = "watchdog_tests.rs"]
mod tests;

#[cfg(windows)]
fn force_exit() -> ! {
    // SAFETY: the pseudo handle always refers to this process and is never closed.
    unsafe {
        windows_sys::Win32::System::Threading::TerminateProcess(
            windows_sys::Win32::System::Threading::GetCurrentProcess(),
            1,
        );
    }
    std::process::abort()
}

#[cfg(not(any(unix, windows)))]
fn force_exit() -> ! {
    std::process::abort()
}
