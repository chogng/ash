use super::*;
use crate::CancellationSource;
use std::future::pending;
use std::future::poll_fn;
use std::future::ready;
use std::task::Context;
use std::task::Waker;
use std::time::Duration;

#[test]
fn blocking_wait_preserves_wakes_consumed_by_synchronous_code() {
    let (finished, result) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let mut first_poll = true;
        crate::block_on(poll_fn(|context| {
            if first_poll {
                first_poll = false;
                context.waker().wake_by_ref();
                // Contended Once initialization can consume the thread's park token during
                // a poll. The executor must retain its wake independently of that token.
                std::thread::park_timeout(Duration::ZERO);
                Poll::Pending
            } else {
                Poll::Ready(())
            }
        }));
        finished.send(()).unwrap();
    });
    let completed = result.recv_timeout(Duration::from_secs(2));
    // Release a broken executor before asserting, so a regression leaves no parked worker.
    worker.thread().unpark();
    worker.join().unwrap();
    completed.expect("blocking executor lost the wake consumed by synchronous code");
}

#[test]
fn cancellation_precedes_ready_condition_and_deadline() {
    let source = CancellationSource::new();
    source.cancel();
    assert!(pollster::block_on(wait_until(ready(7), Instant::now(), &source.token())).is_err());
}

#[test]
fn ready_condition_precedes_expiry() {
    assert_eq!(
        pollster::block_on(wait_until(
            ready(7),
            Instant::now(),
            &CancellationSource::new().token()
        ))
        .unwrap(),
        WaitOutcome::Ready(7)
    );
}

#[test]
fn expired_deadline_returns_without_condition() {
    assert_eq!(
        pollster::block_on(wait_until(
            pending::<()>(),
            Instant::now(),
            &CancellationSource::new().token()
        ))
        .unwrap(),
        WaitOutcome::TimedOut
    );
}

#[test]
fn notification_between_subscription_and_poll_is_retained() {
    let notify = Notify::default();
    let listener = notify.listen();
    notify.notify();
    assert_eq!(
        pollster::block_on(wait_until(
            listener,
            Instant::now(),
            &CancellationSource::new().token()
        ))
        .unwrap(),
        WaitOutcome::Ready(())
    );
}

#[test]
fn pending_wait_yields_and_can_be_cancelled() {
    let source = CancellationSource::new();
    let token = source.token();
    let mut wait = Box::pin(wait_until(
        pending::<()>(),
        Instant::now() + Duration::from_secs(3600),
        &token,
    ));
    assert!(
        wait.as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    source.cancel();
    assert!(matches!(
        wait.as_mut().poll(&mut Context::from_waker(Waker::noop())),
        Poll::Ready(Err(_))
    ));
}

#[test]
fn timer_wakes_without_an_executor_runtime() {
    let start = Instant::now();
    let duration = Duration::from_millis(10);
    assert_eq!(
        pollster::block_on(wait_until(
            pending::<()>(),
            start + duration,
            &CancellationSource::new().token()
        ))
        .unwrap(),
        WaitOutcome::TimedOut
    );
    assert!(start.elapsed() >= duration);
}
