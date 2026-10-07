use super::*;
use crate::CodeSnapshot;
use crate::SourceTask;
use crate::digest;
use protocol::SessionId;

fn package() -> TaskPackage {
    TaskPackage {
        delivery_id: digest(b"delivery"),
        source: SourceTask {
            profile_id: digest(b"win"),
            session_id: SessionId::new("source-session").unwrap(),
            thread_id: ThreadId::new("source-thread").unwrap(),
        },
        title: "Mac 验收".into(),
        instructions: "验证启动".into(),
        context: "Windows 已通过".into(),
        code: CodeSnapshot {
            head: "a".repeat(40),
            tree: "b".repeat(40),
            prerequisite: None,
            pack: "cGFjaw==".into(),
            pack_digest: digest(b"pack"),
        },
    }
}

#[test]
fn outgoing_package_is_durable_immutable_and_scoped_to_its_thread() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite3");
    let store = Store::open(&path).unwrap();
    let task = OutgoingTask {
        host: "mac".into(),
        root: "/work/project".into(),
        request: "request".into(),
        package: package(),
    };
    assert_eq!(store.save_outgoing(&task).unwrap(), task);
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(
        store
            .outgoing(&task.package.source.thread_id, &task.package.delivery_id)
            .unwrap(),
        task
    );
    let links = store
        .outgoing_links(&task.package.source.thread_id)
        .unwrap();
    assert_eq!(
        links["tasks"][0]["delivery_id"],
        task.package.delivery_id.as_str()
    );
    assert!(links["tasks"][0].get("pack").is_none());
    let route = store
        .outgoing_target(&task.package.source.thread_id, &task.package.delivery_id)
        .unwrap();
    assert_eq!(route.host().as_str(), "mac");
    assert_eq!(route.dir().as_str(), "/work/project");
    assert!(matches!(
        store.outgoing(&ThreadId::new("other").unwrap(), &task.package.delivery_id),
        Err(Error::NotFound)
    ));
    assert!(matches!(
        store.outgoing_target(&ThreadId::new("other").unwrap(), &task.package.delivery_id),
        Err(Error::NotFound)
    ));
    let mut changed = task.clone();
    changed.package.code.tree = "c".repeat(40);
    assert!(matches!(
        store.save_outgoing(&changed),
        Err(Error::Conflict)
    ));
    assert_eq!(store.save_outgoing(&task).unwrap(), task);
}

#[test]
fn receive_reservation_survives_a_crash_before_acceptance_and_replays_one_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite3");
    let task = package();
    let store = Store::open(&path).unwrap();
    store.reserve_incoming(&task).unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    assert!(store.receipt(&task.delivery_id).unwrap().is_none());
    store.reserve_incoming(&task).unwrap();
    let receipt = TaskReceipt {
        delivery_id: task.delivery_id.clone(),
        source: task.source.clone(),
        session_id: SessionId::new("destination").unwrap(),
        thread_id: ThreadId::new("destination").unwrap(),
        directory: "/isolated/worktree".into(),
        head: task.code.head.clone(),
        tree: task.code.tree.clone(),
    };
    store.accept(&receipt).unwrap();
    store.accept(&receipt).unwrap();
    assert_eq!(store.receipt(&task.delivery_id).unwrap(), Some(receipt));
    let mut changed = task;
    changed.instructions = "different work".into();
    assert!(matches!(
        store.reserve_incoming(&changed),
        Err(Error::Conflict)
    ));
}
