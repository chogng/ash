use std::sync::Arc;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use std::time::Instant;

use super::RequestCancelStatus;
use super::RequestCancellationRegistry;
use super::RequestScheduler;
use super::RequestSerializationScope;
use ash_app_server_protocol::protocol::registry::SerializationAccess;

fn session(id: &str, access: SerializationAccess) -> RequestSerializationScope {
    RequestSerializationScope::Session {
        session_id: id.into(),
        access,
    }
}

fn connection_resource(id: &str) -> RequestSerializationScope {
    RequestSerializationScope::ConnectionResource {
        namespace: "resourceId",
        resource_id: id.into(),
        access: SerializationAccess::Exclusive,
    }
}

#[test]
fn github_mutations_wait_for_readers_across_connections_and_cancel_without_blocking_other_repositories()
 {
    let scheduler = RequestScheduler::default();
    let scope = |name: &str, access| RequestSerializationScope::HostedRepository {
        host: "github.com".into(),
        owner: "queue-test-team".into(),
        name: name.into(),
        access,
    };
    let reader = scheduler
        .acquire(1, scope("repo", SerializationAccess::SharedRead))
        .unwrap();
    let another_reader = scheduler
        .acquire(2, scope("repo", SerializationAccess::SharedRead))
        .unwrap();
    let source = ash_async_utils::CancellationSource::new();
    let (send, receive) = mpsc::channel();
    scheduler.schedule(
        3,
        scope("repo", SerializationAccess::Exclusive),
        source.token(),
        move |permit| {
            send.send(permit).unwrap();
        },
    );
    assert_eq!(scheduler.waiting_count(), 1);
    let unrelated = scheduler
        .acquire(3, scope("another", SerializationAccess::Exclusive))
        .unwrap();
    source.cancel();
    scheduler.cancel_waiting_requests();
    assert!(
        receive
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .is_err()
    );
    drop((reader, another_reader, unrelated));
    assert_eq!(scheduler.waiting_count(), 0);
}

#[test]
fn repository_admission_spans_runtimes_without_merging_connection_lifetimes() {
    let repository = tempfile::tempdir().unwrap();
    let first = RequestScheduler::default();
    let second = RequestScheduler::default();
    let scope = || RequestSerializationScope::Repository {
        common_dir: repository.path().to_path_buf(),
        access: SerializationAccess::Exclusive,
    };
    let held = first.acquire(1, scope()).unwrap();
    let cancellation = ash_async_utils::CancellationSource::new();
    let (ready, admitted) = mpsc::channel();
    second.schedule(1, scope(), cancellation.token(), move |permit| {
        ready.send(permit).unwrap();
    });
    assert!(admitted.try_recv().is_err());
    assert_eq!(second.waiting_count(), 1);
    let unrelated = second
        .acquire(
            2,
            RequestSerializationScope::Global {
                access: SerializationAccess::SharedRead,
            },
        )
        .unwrap();
    first.cancel_connection(1);
    assert!(admitted.try_recv().is_err());
    drop(held);
    let next = admitted
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .unwrap();
    drop(next);
    drop(unrelated);
    first.finish_connection(1);
}

fn wait_until_waiting(scheduler: &RequestScheduler, count: usize) {
    let deadline = Instant::now() + Duration::from_secs(1);
    while scheduler.waiting_count() != count {
        assert!(
            Instant::now() < deadline,
            "request did not enter scheduler queue"
        );
        thread::yield_now();
    }
}

#[test]
fn exclusive_requests_with_the_same_key_run_fifo() {
    let scheduler = RequestScheduler::default();
    let first = scheduler
        .acquire(1, session("same", SerializationAccess::Exclusive))
        .unwrap();
    let (sender, receiver) = mpsc::channel();

    let second_scheduler = scheduler.clone();
    let second_sender = sender.clone();
    let second = thread::spawn(move || {
        let authorization = second_scheduler
            .acquire(2, session("same", SerializationAccess::Exclusive))
            .unwrap();
        second_sender.send(2).unwrap();
        drop(authorization);
    });
    wait_until_waiting(&scheduler, 1);

    let third_scheduler = scheduler.clone();
    let third = thread::spawn(move || {
        let authorization = third_scheduler
            .acquire(3, session("same", SerializationAccess::Exclusive))
            .unwrap();
        sender.send(3).unwrap();
        drop(authorization);
    });
    wait_until_waiting(&scheduler, 2);

    drop(first);
    assert_eq!(receiver.recv_timeout(Duration::from_secs(1)).unwrap(), 2);
    assert_eq!(receiver.recv_timeout(Duration::from_secs(1)).unwrap(), 3);
    second.join().unwrap();
    third.join().unwrap();
}

#[test]
fn unrelated_session_keys_do_not_block_each_other() {
    let scheduler = RequestScheduler::default();
    let _first = scheduler
        .acquire(1, session("first", SerializationAccess::Exclusive))
        .unwrap();

    let second = scheduler
        .acquire(2, session("second", SerializationAccess::Exclusive))
        .unwrap();
    drop(second);
}

#[test]
fn equal_resource_ids_on_different_connections_are_isolated() {
    let scheduler = RequestScheduler::default();
    let _first = scheduler.acquire(1, connection_resource("same")).unwrap();

    let second = scheduler.acquire(2, connection_resource("same")).unwrap();
    drop(second);
}

#[test]
fn adjacent_shared_reads_run_together_before_a_waiting_writer() {
    let scheduler = Arc::new(RequestScheduler::default());
    let first = scheduler
        .acquire(1, session("same", SerializationAccess::SharedRead))
        .unwrap();
    let second = scheduler
        .acquire(2, session("same", SerializationAccess::SharedRead))
        .unwrap();
    let (sender, receiver) = mpsc::channel();
    let writer_scheduler = Arc::clone(&scheduler);
    let writer = thread::spawn(move || {
        let authorization = writer_scheduler
            .acquire(3, session("same", SerializationAccess::Exclusive))
            .unwrap();
        sender.send(()).unwrap();
        drop(authorization);
    });
    wait_until_waiting(&scheduler, 1);

    drop(first);
    assert!(receiver.recv_timeout(Duration::from_millis(25)).is_err());
    drop(second);
    receiver.recv_timeout(Duration::from_secs(1)).unwrap();
    writer.join().unwrap();
}

#[test]
fn closing_a_connection_cancels_its_queued_requests() {
    let scheduler = RequestScheduler::default();
    let first = scheduler
        .acquire(1, session("same", SerializationAccess::Exclusive))
        .unwrap();
    let queued_scheduler = scheduler.clone();
    let queued = thread::spawn(move || {
        queued_scheduler.acquire(2, session("same", SerializationAccess::Exclusive))
    });
    wait_until_waiting(&scheduler, 1);

    scheduler.cancel_connection(2);
    assert!(queued.join().unwrap().is_err());
    scheduler.finish_connection(2);
    drop(first);
}

#[test]
fn cancellation_requested_before_start_reaches_the_operation() {
    let registry = RequestCancellationRegistry::default();

    assert_eq!(
        registry.cancel_operation(1, "operation-1".into()),
        RequestCancelStatus::Requested
    );
    let cancellation = registry.start(1, 10, Some("operation-1".into())).unwrap();

    assert!(cancellation.is_cancelled());
    assert_eq!(
        registry.cancel_operation(1, "operation-1".into()),
        RequestCancelStatus::AlreadyRequested
    );
    registry.finish(1, 10);
    assert_eq!(
        registry.cancel_operation(1, "operation-1".into()),
        RequestCancelStatus::Completed
    );
}

#[test]
fn equal_operation_ids_on_different_connections_are_isolated() {
    let registry = RequestCancellationRegistry::default();
    let first = registry.start(1, 10, Some("same".into())).unwrap();
    let second = registry.start(2, 10, Some("same".into())).unwrap();

    assert_eq!(
        registry.cancel_operation(1, "same".into()),
        RequestCancelStatus::Requested
    );
    assert!(first.is_cancelled());
    assert!(!second.is_cancelled());
}

#[test]
fn operation_identity_cannot_be_reused_on_a_connection() {
    let registry = RequestCancellationRegistry::default();
    registry.start(1, 10, Some("same".into())).unwrap();

    assert!(registry.start(1, 11, Some("same".into())).is_err());
    registry.finish(1, 10);
    assert!(registry.start(1, 12, Some("same".into())).is_err());
}

#[test]
fn closing_a_connection_cancels_and_forgets_its_operations() {
    let registry = RequestCancellationRegistry::default();
    let cancellation = registry.start(1, 10, Some("operation-1".into())).unwrap();

    registry.cancel_connection(1);

    assert!(cancellation.is_cancelled());
    assert!(registry.start(1, 11, Some("operation-1".into())).is_ok());
}
