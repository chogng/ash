use super::*;
use crate::{CancellationReason, CancellationSource};
use std::future::{Future, pending, ready};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::task::{Context, Poll, Wake, Waker};

#[derive(Default)]
struct WakeCounter(AtomicUsize);

impl Wake for WakeCounter {
    fn wake(self: Arc<Self>) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn poll_once<F: Future>(future: Pin<&mut F>, counter: &Arc<WakeCounter>) -> Poll<F::Output> {
    let waker = Waker::from(counter.clone());
    let mut context = Context::from_waker(&waker);
    future.poll(&mut context)
}

#[test]
fn completed_future_returns_output() {
    let source = CancellationSource::new();
    let counter = Arc::new(WakeCounter::default());
    let mut future = Box::pin(ready(42).with_cancellation(source.token()));

    assert!(matches!(
        poll_once(future.as_mut(), &counter),
        Poll::Ready(Ok(42))
    ));
    assert_eq!(source.token().waiter_count(), 0);
}

#[test]
fn wrapper_accepts_non_unpin_futures() {
    let source = CancellationSource::new();
    let counter = Arc::new(WakeCounter::default());
    let mut future = Box::pin(
        async {
            let value = ready(41).await;
            value + 1
        }
        .with_cancellation(source.token()),
    );

    assert!(matches!(
        poll_once(future.as_mut(), &counter),
        Poll::Ready(Ok(42))
    ));
}

struct PollCounter {
    polls: Arc<AtomicUsize>,
}

impl Future for PollCounter {
    type Output = ();

    fn poll(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Self::Output> {
        self.polls.fetch_add(1, Ordering::SeqCst);
        Poll::Pending
    }
}

#[test]
fn prior_cancellation_wins_without_polling_inner_future() {
    let source = CancellationSource::new();
    source.cancel_with(CancellationReason::Shutdown);
    let polls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::new(WakeCounter::default());
    let mut future = Box::pin(
        PollCounter {
            polls: polls.clone(),
        }
        .with_cancellation(source.token()),
    );

    let Poll::Ready(Err(cancellation)) = poll_once(future.as_mut(), &counter) else {
        panic!("cancelled wrapper should resolve with an error");
    };
    assert_eq!(cancellation.reason(), &CancellationReason::Shutdown);
    assert_eq!(polls.load(Ordering::SeqCst), 0);
}

struct DropFlag(Arc<AtomicBool>);

impl Future for DropFlag {
    type Output = ();

    fn poll(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Self::Output> {
        Poll::Pending
    }
}

impl Drop for DropFlag {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[test]
fn cancellation_wakes_wrapper_and_drops_inner_future() {
    let source = CancellationSource::new();
    let dropped = Arc::new(AtomicBool::new(false));
    let counter = Arc::new(WakeCounter::default());
    let mut future = Box::pin(DropFlag(dropped.clone()).with_cancellation(source.token()));

    assert!(poll_once(future.as_mut(), &counter).is_pending());
    source.cancel();
    assert_eq!(counter.0.load(Ordering::SeqCst), 1);
    assert!(matches!(
        poll_once(future.as_mut(), &counter),
        Poll::Ready(Err(_))
    ));
    assert!(dropped.load(Ordering::SeqCst));
}

struct CancelAndComplete {
    source: CancellationSource,
}

impl Future for CancelAndComplete {
    type Output = &'static str;

    fn poll(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Self::Output> {
        self.source.cancel();
        Poll::Ready("completed")
    }
}

#[test]
fn inner_completion_wins_when_cancellation_happens_during_inner_poll() {
    let source = CancellationSource::new();
    let counter = Arc::new(WakeCounter::default());
    let mut future = Box::pin(
        CancelAndComplete {
            source: source.clone(),
        }
        .with_cancellation(source.token()),
    );

    assert!(matches!(
        poll_once(future.as_mut(), &counter),
        Poll::Ready(Ok("completed"))
    ));
}

#[test]
fn dropping_pending_wrapper_unregisters_cancellation_waiter() {
    let source = CancellationSource::new();
    let token = source.token();
    let counter = Arc::new(WakeCounter::default());

    {
        let mut future = Box::pin(pending::<()>().with_cancellation(token.clone()));
        assert!(poll_once(future.as_mut(), &counter).is_pending());
        assert_eq!(token.waiter_count(), 1);
    }

    assert_eq!(token.waiter_count(), 0);
}
