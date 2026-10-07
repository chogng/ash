use super::*;
use std::pin::pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier};
use std::task::{Context, Wake, Waker};
use std::thread;

#[derive(Default)]
struct WakeCounter(AtomicUsize);

impl Wake for WakeCounter {
    fn wake(self: Arc<Self>) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn counter_waker(counter: &Arc<WakeCounter>) -> Waker {
    Waker::from(counter.clone())
}

fn poll_cancelled<R>(future: Pin<&mut Cancelled<R>>, waker: &Waker) -> Poll<Cancellation<R>> {
    let mut context = Context::from_waker(waker);
    future.poll(&mut context)
}

#[test]
fn cancellation_is_idempotent_and_preserves_first_reason() {
    let source = CancellationSource::<&'static str>::new_typed();

    let first = source.cancel_with("first");
    let second = source.cancel_with("second");

    assert!(matches!(first, CancelResult::Cancelled(_)));
    assert!(matches!(second, CancelResult::AlreadyCancelled(_)));
    assert_eq!(first.cancellation().reason(), &"first");
    assert_eq!(second.cancellation().reason(), &"first");
    assert_eq!(first.cancellation().origin(), source.id());
}

#[test]
fn reason_does_not_need_to_implement_clone() {
    #[derive(Debug)]
    struct NonCloneReason(&'static str);

    let source = CancellationSource::<NonCloneReason>::new_typed();
    let child = source.token().child_source();

    source.cancel_with(NonCloneReason("owner stopped"));

    assert_eq!(
        child
            .token()
            .cancellation()
            .expect("child should inherit cancellation")
            .reason()
            .0,
        "owner stopped"
    );
}

#[test]
fn parent_cancellation_reaches_all_descendants_with_original_signal() {
    let parent = CancellationSource::<&'static str>::new_typed();
    let child = parent.token().child_source();
    let grandchild = child.token().child_source();

    parent.cancel_with("stop");

    for token in [parent.token(), child.token(), grandchild.token()] {
        let cancellation = token.cancellation().expect("domain should be cancelled");
        assert_eq!(cancellation.reason(), &"stop");
        assert_eq!(cancellation.origin(), parent.id());
    }
}

#[test]
fn child_cancellation_is_isolated_from_parent_and_sibling() {
    let parent = CancellationSource::<&'static str>::new_typed();
    let child = parent.token().child_source();
    let sibling = parent.token().child_source();
    let grandchild = child.token().child_source();

    child.cancel_with("child stopped");

    assert!(!parent.token().is_cancelled());
    assert!(!sibling.token().is_cancelled());
    assert!(child.token().is_cancelled());
    let inherited = grandchild
        .token()
        .cancellation()
        .expect("grandchild should inherit child cancellation");
    assert_eq!(inherited.origin(), child.id());
}

#[test]
fn child_created_after_cancellation_inherits_signal() {
    let parent = CancellationSource::<String>::new_typed();
    parent.cancel_with("shutdown".to_string());

    let child = parent.token().child_source();
    let cancellation = child
        .token()
        .cancellation()
        .expect("new child should start cancelled");

    assert_eq!(cancellation.reason(), "shutdown");
    assert_eq!(cancellation.origin(), parent.id());
}

#[test]
fn concurrent_child_creation_cannot_miss_parent_cancellation() {
    for _ in 0..100 {
        let parent = CancellationSource::<usize>::new_typed();
        let token = parent.token();
        let barrier = Arc::new(Barrier::new(2));
        let thread_barrier = barrier.clone();

        let creator = thread::spawn(move || {
            thread_barrier.wait();
            token.child_source()
        });
        barrier.wait();
        parent.cancel_with(7);

        let child = creator.join().expect("child creator should not panic");
        assert_eq!(
            child
                .token()
                .cancellation()
                .expect("child must observe parent cancellation")
                .reason(),
            &7
        );
    }
}

#[test]
fn cancellation_wakes_every_registered_waiter() {
    let source = CancellationSource::new();
    let first_counter = Arc::new(WakeCounter::default());
    let second_counter = Arc::new(WakeCounter::default());
    let first_waker = counter_waker(&first_counter);
    let second_waker = counter_waker(&second_counter);
    let mut first = pin!(source.token().cancelled());
    let mut second = pin!(source.token().cancelled());

    assert!(poll_cancelled(first.as_mut(), &first_waker).is_pending());
    assert!(poll_cancelled(second.as_mut(), &second_waker).is_pending());
    source.cancel();

    assert_eq!(first_counter.0.load(Ordering::SeqCst), 1);
    assert_eq!(second_counter.0.load(Ordering::SeqCst), 1);
    assert!(poll_cancelled(first.as_mut(), &first_waker).is_ready());
    assert!(poll_cancelled(second.as_mut(), &second_waker).is_ready());
}

#[test]
fn repoll_replaces_a_stale_waker() {
    let source = CancellationSource::new();
    let stale_counter = Arc::new(WakeCounter::default());
    let current_counter = Arc::new(WakeCounter::default());
    let stale_waker = counter_waker(&stale_counter);
    let current_waker = counter_waker(&current_counter);
    let mut cancelled = pin!(source.token().cancelled());

    assert!(poll_cancelled(cancelled.as_mut(), &stale_waker).is_pending());
    assert!(poll_cancelled(cancelled.as_mut(), &current_waker).is_pending());
    source.cancel();

    assert_eq!(stale_counter.0.load(Ordering::SeqCst), 0);
    assert_eq!(current_counter.0.load(Ordering::SeqCst), 1);
}

#[test]
fn dropping_waiter_unregisters_its_waker() {
    let source = CancellationSource::new();
    let token = source.token();
    let counter = Arc::new(WakeCounter::default());
    let waker = counter_waker(&counter);

    {
        let mut cancelled = pin!(token.cancelled());
        assert!(poll_cancelled(cancelled.as_mut(), &waker).is_pending());
        assert_eq!(token.waiter_count(), 1);
    }

    assert_eq!(token.waiter_count(), 0);
    source.cancel();
    assert_eq!(counter.0.load(Ordering::SeqCst), 0);
}

#[test]
fn cancel_on_drop_guard_can_be_armed_or_disarmed() {
    let armed_source = CancellationSource::new();
    let armed_token = armed_source.token();
    {
        let _guard = armed_source.cancel_on_drop();
    }
    assert!(armed_token.is_cancelled());

    let disarmed_source = CancellationSource::new();
    let disarmed_token = disarmed_source.token();
    disarmed_source.cancel_on_drop().disarm();
    assert!(!disarmed_token.is_cancelled());
}

#[test]
fn dropping_a_plain_source_does_not_cancel_tokens() {
    let token = {
        let source = CancellationSource::new();
        source.token()
    };

    assert!(!token.is_cancelled());
}

#[test]
fn very_deep_hierarchy_cancels_without_recursion() {
    let root = CancellationSource::new();
    let mut domains = vec![root.token().child_source()];
    for _ in 0..10_000 {
        domains.push(
            domains
                .last()
                .expect("hierarchy has a parent")
                .token()
                .child_source(),
        );
    }

    root.cancel();

    assert!(
        domains
            .last()
            .expect("hierarchy has a leaf")
            .token()
            .is_cancelled()
    );
}
