use std::io;
use std::sync::Arc;
use std::sync::Mutex;

#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod platform;
#[cfg(windows)]
#[path = "windows.rs"]
mod platform;
#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod platform;
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
#[path = "unsupported.rs"]
mod platform;

type Acquire = dyn Fn(&str) -> io::Result<Box<dyn Send>> + Send + Sync;

/// Shares one OS idle-sleep assertion across overlapping operations.
/// Clones share ownership; each successful acquisition must be held for the operation's scope.
#[derive(Clone)]
pub struct SleepInhibitor {
    inner: Arc<Inner>,
}

struct Inner {
    reason: String,
    acquire: Box<Acquire>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    leases: usize,
    assertion: Option<Box<dyn Send>>,
}

impl SleepInhibitor {
    pub fn new(reason: impl Into<String>) -> Self {
        Self {
            inner: Arc::new(Inner {
                reason: reason.into(),
                acquire: Box::new(platform::acquire),
                state: Mutex::new(State::default()),
            }),
        }
    }

    /// Acquires idle-sleep protection or returns the platform error without retaining a lease.
    pub fn acquire(&self) -> io::Result<SleepInhibition> {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.leases == 0 {
            state.assertion = Some((self.inner.acquire)(&self.inner.reason)?);
        }
        state.leases += 1;
        Ok(SleepInhibition {
            inner: Arc::clone(&self.inner),
        })
    }
}

/// Releases this operation's claim on drop; the last claim releases the OS assertion.
/// It may be moved to another thread and outlive the controller that acquired it.
#[must_use = "hold the lease for the duration of the operation"]
pub struct SleepInhibition {
    inner: Arc<Inner>,
}

impl Drop for SleepInhibition {
    fn drop(&mut self) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.leases -= 1;
        if state.leases == 0 {
            // Release while locked, so another acquisition cannot overlap OS assertions.
            state.assertion = None;
        }
    }
}

#[cfg(test)]
#[path = "inhibitor_tests.rs"]
mod tests;
