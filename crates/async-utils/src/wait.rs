use crate::Cancellation;
use crate::CancellationToken;
use crate::FutureCancellationExt;
use std::future::Future;
use std::future::poll_fn;
use std::pin::pin;
use std::task::Poll;
use std::time::Instant;

/// Result of a condition wait. Expiry only ends the wait, never the observed work.
#[derive(Debug, PartialEq, Eq)]
pub enum WaitOutcome<T> {
    Ready(T),
    TimedOut,
}

/// Waits for a condition, a monotonic deadline, or owner cancellation.
///
/// Cancellation takes precedence at each poll, then a ready condition, then expiry.
/// The condition must be safe to drop. The timer works without a Tokio runtime and is
/// deregistered when this future completes or is dropped; no worker is created per wait.
pub async fn wait_until<F: Future>(
    condition: F,
    deadline: Instant,
    cancellation: &CancellationToken,
) -> Result<WaitOutcome<F::Output>, Cancellation> {
    let mut condition = pin!(condition);
    let mut timer = pin!(async_io::Timer::at(deadline));
    poll_fn(|cx| {
        if let Poll::Ready(value) = condition.as_mut().poll(cx) {
            return Poll::Ready(WaitOutcome::Ready(value));
        }
        timer.as_mut().poll(cx).map(|_| WaitOutcome::TimedOut)
    })
    .with_cancellation(cancellation.clone())
    .await
}

/// Wakeups for owner-held state; notifications carry no data and are not durable.
/// Consumers subscribe before inspecting their state, then recheck it after waking.
#[derive(Default)]
pub struct Notify {
    event: event_listener::Event,
}

impl Notify {
    /// Registers immediately, even before the returned future is first polled.
    pub fn listen(&self) -> impl Future<Output = ()> + Send + use<> {
        self.event.listen()
    }

    /// Wakes all current subscribers. Future subscribers must inspect owner state.
    pub fn notify(&self) {
        self.event.notify(usize::MAX);
    }
}

#[cfg(test)]
#[path = "wait_tests.rs"]
mod tests;
