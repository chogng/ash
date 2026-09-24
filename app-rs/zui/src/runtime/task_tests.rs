use futures::executor::block_on;
use futures::future::AbortHandle;
use futures::future::Abortable;
use futures::future::pending;
use std::sync::mpsc;
use std::time::Duration;

use super::BackgroundExecutor;
use super::TaskEntry;
use super::TaskId;
use super::TaskRegistry;
use super::TaskScope;

#[test]
fn cancelling_a_scope_aborts_and_removes_its_tasks() {
    let (abort, registration) = AbortHandle::new_pair();
    let mut registry = TaskRegistry::default();
    registry.insert(
        TaskId(1),
        TaskEntry {
            scope: TaskScope::Application,
            abort,
        },
    );

    registry.cancel_scope(TaskScope::Application);

    assert!(registry.entries.is_empty());
    assert!(block_on(Abortable::new(pending::<()>(), registration)).is_err());
}

#[test]
fn completion_is_reported_only_for_a_still_registered_task() {
    let (abort, _) = AbortHandle::new_pair();
    let mut registry = TaskRegistry::default();
    registry.insert(
        TaskId(7),
        TaskEntry {
            scope: TaskScope::Application,
            abort,
        },
    );

    assert!(registry.complete(TaskId(7)));
    assert!(!registry.complete(TaskId(7)));
}

#[test]
fn application_tasks_use_the_named_shared_worker_pool() {
    let pool = BackgroundExecutor::<()>::create_pool().unwrap();
    let (sender, receiver) = mpsc::channel();

    for _ in 0..4 {
        let sender = sender.clone();
        pool.spawn_ok(async move {
            let name = std::thread::current().name().map(str::to_owned);
            sender.send(name).unwrap();
        });
    }
    drop(sender);

    for _ in 0..4 {
        let name = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(name.is_some_and(|name| name.starts_with("zui-task-")));
    }
}
