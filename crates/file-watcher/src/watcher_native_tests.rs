use super::*;
use crate::FileWatcherEvent;
use std::process::Command;
use std::time::Duration;
use std::time::Instant;

#[tokio::test]
async fn stalled_native_update_restores_old_and_new_scopes_and_future_edits() {
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().canonicalize().unwrap();
    let first = root.join("first");
    let second = root.join("second");
    std::fs::create_dir(&first).unwrap();
    std::fs::create_dir(&second).unwrap();
    let file = first.join("tracked.txt");
    std::fs::write(&file, "before").unwrap();
    let (events, raw_rx) = crate::ingress::event_channel();
    let mut child = Command::new(std::env::current_exe().unwrap());
    child.args([
        "--exact",
        "native::tests::process_helper",
        "--ignored",
        "--nocapture",
    ]);
    child.env("ASH_WATCHER_TEST_CHILD", "hang-on-second");
    let native =
        crate::native::NativeWatcher::spawn(child, events.clone(), Duration::from_millis(100))
            .unwrap();
    let watcher = Arc::new(FileWatcher {
        inner: Some(Arc::new(Mutex::new(FileWatcherInner {
            watcher: BackendWatcher::Isolated {
                watcher: native,
                added: BTreeMap::new(),
                removed: BTreeSet::new(),
                events,
            },
            watched_paths: HashMap::new(),
        }))),
        state: Arc::new(RwLock::new(WatchState::default())),
        watch_parents: true,
    });
    watcher.spawn_event_loop(raw_rx);
    let (subscriber, mut receiver) = watcher.add_subscriber();
    let _first = subscriber
        .register_paths(vec![WatchPath {
            path: first.clone(),
            recursive: true,
        }])
        .unwrap();
    let started = Instant::now();
    let _second = subscriber
        .register_paths(vec![WatchPath {
            path: second.clone(),
            recursive: true,
        }])
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(matches!(
        watcher.inner.as_ref().unwrap().lock().unwrap().watcher,
        BackendWatcher::Polling { .. }
    ));
    assert_eq!(watcher.backend_contents_for_test(&first), Some(true));
    assert_eq!(watcher.backend_contents_for_test(&second), Some(true));
    assert_eq!(watcher.backend_contents_for_test(&root), Some(false));
    {
        let mut inner = watcher.inner.as_ref().unwrap().lock().unwrap();
        let BackendWatcher::Polling { paths, .. } = &mut inner.watcher else {
            unreachable!()
        };
        // Native parent leases must not become polling scopes of unrelated siblings.
        assert!(!paths.contains_key(&root));
    }
    loop {
        let event = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        if let FileWatcherEvent::RescanRequired { watched_paths } = event {
            assert_eq!(watched_paths, vec![first.clone(), second.clone()]);
            break;
        }
    }
    // A rescan alone could hide a dead replacement. Require later independent writes in
    // both the old registration and the transaction that triggered the failure.
    for (file, content) in [(file, "after"), (second.join("new.txt"), "new")] {
        std::fs::write(&file, content).unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Some(FileWatcherEvent::PathsChanged { paths }) = receiver.recv().await
                    && paths.contains(&file)
                {
                    break;
                }
            }
        })
        .await
        .unwrap();
    }
}
