use super::*;
use crate::CancellationSource;
use std::future::pending;
use std::future::ready;
use std::task::Context;
use std::task::Waker;
use std::time::Duration;

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
