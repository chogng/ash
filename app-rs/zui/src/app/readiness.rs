use std::collections::HashMap;
use std::error::Error;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::task::Context;
use std::task::Poll;
use std::task::Waker;

use super::ApplicationHandle;

/// Failure returned when an application exits before its first ready callback completes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ApplicationReadyError;

impl fmt::Display for ApplicationReadyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("application exited before becoming ready")
    }
}

impl Error for ApplicationReadyError {}

/// Owned future that completes after [`super::App::ready`] returns for the first time.
///
/// The future is `Send` and resolves with [`ApplicationReadyError`] instead of hanging if the
/// application event loop exits first.
pub struct ApplicationReadyFuture {
    readiness: ApplicationReadiness,
    waiter: Option<u64>,
}

impl fmt::Debug for ApplicationReadyFuture {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ApplicationReadyFuture")
            .finish_non_exhaustive()
    }
}

impl Future for ApplicationReadyFuture {
    type Output = Result<(), ApplicationReadyError>;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.as_mut().get_mut();
        this.readiness.poll(&mut this.waiter, context.waker())
    }
}

impl Drop for ApplicationReadyFuture {
    fn drop(&mut self) {
        if let Some(waiter) = self.waiter.take() {
            self.readiness.remove_waiter(waiter);
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct ApplicationReadiness {
    shared: Arc<Mutex<ReadinessState>>,
}

#[derive(Default)]
struct ReadinessState {
    phase: ReadinessPhase,
    next_waiter: u64,
    waiters: HashMap<u64, Waker>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum ReadinessPhase {
    #[default]
    Pending,
    Ready,
    Exited,
}

impl ApplicationReadiness {
    pub(crate) fn is_ready(&self) -> bool {
        self.shared
            .lock()
            .expect("application readiness lock")
            .phase
            == ReadinessPhase::Ready
    }

    pub(crate) fn future(&self) -> ApplicationReadyFuture {
        ApplicationReadyFuture {
            readiness: self.clone(),
            waiter: None,
        }
    }

    pub(crate) fn mark_ready(&self) {
        self.transition(ReadinessPhase::Ready);
    }

    pub(crate) fn mark_exited(&self) {
        self.transition(ReadinessPhase::Exited);
    }

    fn poll(
        &self,
        waiter: &mut Option<u64>,
        waker: &Waker,
    ) -> Poll<Result<(), ApplicationReadyError>> {
        let mut state = self.shared.lock().expect("application readiness lock");
        match state.phase {
            ReadinessPhase::Ready => Poll::Ready(Ok(())),
            ReadinessPhase::Exited => Poll::Ready(Err(ApplicationReadyError)),
            ReadinessPhase::Pending => {
                let identity = waiter.unwrap_or_else(|| {
                    let identity = state.next_waiter;
                    state.next_waiter = state
                        .next_waiter
                        .checked_add(1)
                        .expect("application readiness waiter identity exhausted");
                    *waiter = Some(identity);
                    identity
                });
                state.waiters.insert(identity, waker.clone());
                Poll::Pending
            }
        }
    }

    fn remove_waiter(&self, waiter: u64) {
        self.shared
            .lock()
            .expect("application readiness lock")
            .waiters
            .remove(&waiter);
    }

    fn transition(&self, next: ReadinessPhase) {
        let waiters = {
            let mut state = self.shared.lock().expect("application readiness lock");
            if state.phase != ReadinessPhase::Pending {
                return;
            }
            state.phase = next;
            std::mem::take(&mut state.waiters)
        };
        for waiter in waiters.into_values() {
            waiter.wake();
        }
    }
}

impl<T: 'static> ApplicationHandle<T> {
    /// Returns whether the first [`super::App::ready`] callback has completed.
    pub fn is_ready(&self) -> bool {
        self.readiness.is_ready()
    }

    /// Waits for the first [`super::App::ready`] callback to complete.
    ///
    /// Unlike an unbounded notification wait, this future reports an error if the event loop exits
    /// before readiness. It can be moved between threads and created before the native loop starts.
    pub fn when_ready(&self) -> ApplicationReadyFuture {
        self.readiness.future()
    }
}

#[cfg(test)]
#[path = "readiness_tests.rs"]
mod tests;
