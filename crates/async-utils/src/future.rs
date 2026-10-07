use crate::{Cancellation, CancellationToken};
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

/// A future that races an inner future against cooperative cancellation.
///
/// Cancellation is checked before the inner future on every poll. If cancellation is already
/// visible, the inner future is dropped without being polled. If the inner future completes
/// after that check—even if it requests cancellation from inside its own `poll`—its output wins.
///
/// Dropping an in-flight future is not cancellation-safe for every protocol or resource. Code
/// that needs graceful asynchronous cleanup should observe [`CancellationToken::cancelled`]
/// inside the future instead of wrapping it with this type.
#[must_use = "futures do nothing unless polled or awaited"]
pub struct Cancelable<F, R>
where
    F: Future,
{
    future: Option<Pin<Box<F>>>,
    token: CancellationToken<R>,
    waiter_id: Option<u64>,
}

impl<F, R> Cancelable<F, R>
where
    F: Future,
{
    /// Wraps `future` with a cancellation token.
    pub fn new(future: F, token: CancellationToken<R>) -> Self {
        Self {
            future: Some(Box::pin(future)),
            token,
            waiter_id: None,
        }
    }
}

impl<F, R> Future for Cancelable<F, R>
where
    F: Future,
{
    type Output = Result<F::Output, Cancellation<R>>;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.as_mut().get_mut();
        assert!(this.future.is_some(), "Cancelable polled after completion");

        if let Poll::Ready(cancellation) = this.token.poll_cancelled(context, &mut this.waiter_id) {
            this.future = None;
            return Poll::Ready(Err(cancellation));
        }

        let result = this
            .future
            .as_mut()
            .expect("future presence was checked above")
            .as_mut()
            .poll(context);
        match result {
            Poll::Ready(output) => {
                this.future = None;
                this.token.remove_waiter(&mut this.waiter_id);
                Poll::Ready(Ok(output))
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl<F, R> Drop for Cancelable<F, R>
where
    F: Future,
{
    fn drop(&mut self) {
        self.token.remove_waiter(&mut self.waiter_id);
    }
}

/// Adds runtime-independent cooperative cancellation to any [`Future`].
///
/// The crate blanket-implements this trait for every future; future authors should not implement
/// it themselves. Callers should use the wrapper only when dropping the future at a suspension
/// point is safe. For graceful shutdown, pass the token into the future and observe it at explicit
/// checkpoints.
pub trait FutureCancellationExt: Future + Sized {
    /// Races this future against `token`, with already-observed cancellation taking precedence.
    fn with_cancellation<R>(self, token: CancellationToken<R>) -> Cancelable<Self, R> {
        Cancelable::new(self, token)
    }
}

impl<F> FutureCancellationExt for F where F: Future {}

#[cfg(test)]
#[path = "future_tests.rs"]
mod tests;
