use super::*;
use std::sync::mpsc;
use std::time::Duration;

#[test]
fn failed_import_is_terminal_and_does_not_publish_or_keep_a_staging_directory() {
    let root = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let manager = DictationModelManager::default();
    let (send, receive) = mpsc::channel();
    manager
        .start(
            1,
            "import-1".into(),
            ModelRequest {
                model_root: root.path().into(),
                model_id: "imported-model".into(),
                operation: ModelOperation::Import {
                    source: source.path().into(),
                },
            },
            move |event| {
                send.send(event).unwrap();
            },
        )
        .unwrap();
    let mut events = Vec::new();
    loop {
        let event = receive.recv_timeout(Duration::from_secs(5)).unwrap();
        let terminal = matches!(
            event,
            ModelProgress::Ready | ModelProgress::Cancelled | ModelProgress::Failed { .. }
        );
        events.push(event);
        if terminal {
            break;
        }
    }
    assert!(matches!(
        events.as_slice(),
        [ModelProgress::Checking, ModelProgress::Failed { .. }]
    ));
    manager.stop(1, "import-1").unwrap();
    manager.stop(1, "import-1").unwrap();
    assert!(!root.path().join("imported-model").exists());
    assert!(!root.path().join(".imported-model.installing").exists());
    assert!(receive.try_recv().is_err());
}

#[test]
fn duplicate_resource_is_rejected_and_connection_close_releases_only_its_operations() {
    let root = tempfile::tempdir().unwrap();
    let manager = DictationModelManager::default();
    let request = || ModelRequest {
        model_root: root.path().into(),
        model_id: "missing".into(),
        operation: ModelOperation::Import {
            source: root.path().join("absent"),
        },
    };
    manager.start(1, "same".into(), request(), |_| {}).unwrap();
    manager.start(2, "same".into(), request(), |_| {}).unwrap();
    assert!(manager.start(1, "same".into(), request(), |_| {}).is_err());
    manager.close(1);
    assert_eq!(
        manager
            .operations
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        [(2, "same".into())]
    );
    manager.close(2);
    assert!(manager.operations.lock().unwrap().is_empty());
}

#[test]
fn model_availability_checks_the_package_without_starting_inference_or_network() {
    let root = tempfile::tempdir().unwrap();
    assert!(!DictationModelManager::is_available(root.path(), "missing").unwrap());
    assert!(DictationModelManager::is_available(root.path(), "../outside").is_err());
}

#[test]
fn stop_cancels_a_running_import_and_acknowledges_after_its_terminal_event() {
    let root = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let manager = DictationModelManager::default();
    let (send, receive) = mpsc::channel();
    let (permit, gate) = mpsc::channel();
    let gate = Mutex::new(gate);
    manager
        .start(
            1,
            "import".into(),
            ModelRequest {
                model_root: root.path().into(),
                model_id: "cancelled-model".into(),
                operation: ModelOperation::Import {
                    source: source.path().into(),
                },
            },
            move |event| {
                let checking = event == ModelProgress::Checking;
                send.send(event).unwrap();
                if checking {
                    gate.lock().unwrap().recv().unwrap();
                }
            },
        )
        .unwrap();
    assert_eq!(
        receive.recv_timeout(Duration::from_secs(5)).unwrap(),
        ModelProgress::Checking
    );
    let token = manager
        .operations
        .lock()
        .unwrap()
        .get(&(1, "import".into()))
        .unwrap()
        .cancellation
        .token();
    thread::scope(|scope| {
        let stopped = scope.spawn(|| manager.stop(1, "import"));
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(token.cancelled());
        permit.send(()).unwrap();
        stopped.join().unwrap().unwrap();
    });
    assert_eq!(
        receive.recv_timeout(Duration::from_secs(5)).unwrap(),
        ModelProgress::Cancelled
    );
    assert!(receive.try_recv().is_err());
    assert!(!root.path().join(".cancelled-model.installing").exists());
}
