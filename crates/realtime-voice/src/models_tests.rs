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
fn one_process_owned_task_per_model_can_be_cancelled_from_another_connection() {
    let root = tempfile::tempdir().unwrap();
    let manager = DictationModelManager::default();
    let (permit, gate) = mpsc::channel();
    let gate = Mutex::new(gate);
    let (send, receive) = mpsc::channel();
    let request = || ModelRequest {
        model_root: root.path().into(),
        model_id: "shared".into(),
        operation: ModelOperation::Import {
            source: root.path().join("absent"),
        },
    };
    manager
        .start(1, "owner".into(), request(), move |event| {
            let checking = event == ModelProgress::Checking;
            send.send(event).unwrap();
            if checking {
                gate.lock().unwrap().recv().unwrap();
            }
        })
        .unwrap();
    assert_eq!(
        receive.recv_timeout(Duration::from_secs(5)).unwrap(),
        ModelProgress::Checking
    );
    assert_eq!(manager.progress("shared"), Some(ModelProgress::Checking));
    assert!(manager.start(2, "other".into(), request(), |_| {}).is_err());
    assert!(manager.remove(root.path(), "shared").is_err());
    // Releasing an unrelated connection resource must leave this task running.
    manager.stop(2, "owner").unwrap();
    let token = manager
        .operations
        .lock()
        .unwrap()
        .get(&(1, "owner".into()))
        .unwrap()
        .cancellation
        .token();
    thread::scope(|scope| {
        let cancelled = scope.spawn(|| manager.cancel_model("shared"));
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(token.cancelled());
        permit.send(()).unwrap();
        cancelled.join().unwrap().unwrap();
    });
    assert_eq!(
        receive.recv_timeout(Duration::from_secs(5)).unwrap(),
        ModelProgress::Cancelled
    );
    assert_eq!(manager.progress("shared"), Some(ModelProgress::Cancelled));
    assert!(!root.path().join(".shared.installing").exists());
}

#[test]
fn deletion_only_removes_managed_files_and_preserves_import_sources_and_unrelated_content() {
    let root = tempfile::tempdir().unwrap();
    let manager = DictationModelManager::default();
    let installed = root.path().join("installed");
    std::fs::create_dir(&installed).unwrap();
    for name in [
        "encoder.onnx",
        "decoder.onnx",
        "tokens.txt",
        "dictation-model.json",
    ] {
        std::fs::write(installed.join(name), "model").unwrap();
    }
    std::fs::write(installed.join("notes.txt"), "keep").unwrap();
    assert!(manager.remove(root.path(), "installed").is_err());
    assert!(installed.join("encoder.onnx").exists());
    std::fs::remove_file(installed.join("notes.txt")).unwrap();
    let source = tempfile::tempdir().unwrap();
    std::fs::write(source.path().join("encoder.onnx"), "source").unwrap();
    manager.remove(root.path(), "installed").unwrap();
    assert!(!installed.exists());
    assert!(source.path().join("encoder.onnx").exists());
    assert!(manager.remove(root.path(), "../outside").is_err());
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
