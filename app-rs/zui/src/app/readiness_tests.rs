use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::task::Context;
use std::task::Poll;
use std::task::Wake;
use std::task::Waker;

use super::ApplicationReadiness;
use super::ApplicationReadyError;
use super::ApplicationReadyFuture;

fn require_send<T: Send>() {}

#[derive(Default)]
struct WakeCounter(AtomicUsize);

impl Wake for WakeCounter {
    fn wake(self: Arc<Self>) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
}

#[test]
fn ready_future_is_send_and_wakes_after_readiness_commits() {
    require_send::<ApplicationReadyFuture>();
    let readiness = ApplicationReadiness::default();
    let counter = Arc::new(WakeCounter::default());
    let waker = Waker::from(Arc::clone(&counter));
    let mut context = Context::from_waker(&waker);
    let mut future = readiness.future();

    assert!(!readiness.is_ready());
    assert_eq!(Pin::new(&mut future).poll(&mut context), Poll::Pending);
    readiness.mark_ready();

    assert!(readiness.is_ready());
    assert_eq!(counter.0.load(Ordering::Relaxed), 1);
    assert_eq!(
        Pin::new(&mut future).poll(&mut context),
        Poll::Ready(Ok(()))
    );
}

#[test]
fn exit_before_ready_wakes_waiters_with_a_stable_error() {
    let readiness = ApplicationReadiness::default();
    let counter = Arc::new(WakeCounter::default());
    let waker = Waker::from(Arc::clone(&counter));
    let mut context = Context::from_waker(&waker);
    let mut future = readiness.future();
    assert_eq!(Pin::new(&mut future).poll(&mut context), Poll::Pending);

    readiness.mark_exited();

    assert!(!readiness.is_ready());
    assert_eq!(counter.0.load(Ordering::Relaxed), 1);
    assert_eq!(
        Pin::new(&mut future).poll(&mut context),
        Poll::Ready(Err(ApplicationReadyError))
    );
    assert_eq!(
        ApplicationReadyError.to_string(),
        "application exited before becoming ready"
    );
}

#[test]
fn readiness_is_monotonic_after_either_terminal_transition() {
    let ready = ApplicationReadiness::default();
    ready.mark_ready();
    ready.mark_exited();
    assert!(ready.is_ready());

    let exited = ApplicationReadiness::default();
    exited.mark_exited();
    exited.mark_ready();
    assert!(!exited.is_ready());
}

#[test]
fn dropping_a_pending_future_unregisters_its_waker() {
    let readiness = ApplicationReadiness::default();
    let waker = Waker::from(Arc::new(WakeCounter::default()));
    let mut context = Context::from_waker(&waker);
    let mut future = readiness.future();
    assert_eq!(Pin::new(&mut future).poll(&mut context), Poll::Pending);
    assert_eq!(
        readiness
            .shared
            .lock()
            .expect("application readiness lock")
            .waiters
            .len(),
        1
    );

    drop(future);

    assert!(
        readiness
            .shared
            .lock()
            .expect("application readiness lock")
            .waiters
            .is_empty()
    );
}
