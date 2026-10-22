use super::*;
use crate::channel::watch_channel;
use notify::Event;
use notify::EventKind;
use notify::RecursiveMode;
use notify::event::AccessKind;
use notify::event::AccessMode;
use notify::event::CreateKind;
use notify::event::DataChange;
use notify::event::Flag;
use notify::event::ModifyKind;
use pretty_assertions::assert_eq;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use tokio::time::timeout;

const COALESCE_INTERVAL: Duration = Duration::from_millis(40);

fn path(name: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(name)
}

fn watch(path: impl Into<std::path::PathBuf>, recursive: bool) -> WatchPath {
    WatchPath {
        path: path.into(),
        recursive,
    }
}

fn notify_event(kind: EventKind, paths: Vec<std::path::PathBuf>) -> Event {
    paths.into_iter().fold(Event::new(kind), Event::add_path)
}

#[tokio::test]
async fn raw_receiver_sorts_deduplicates_and_closes() {
    let (tx, mut rx) = watch_channel();
    tx.add_changed_paths(&[path("b"), path("a"), path("b")], Vec::new)
        .await;

    assert_eq!(
        rx.recv().await,
        Some(FileWatcherEvent::PathsChanged {
            paths: vec![path("a"), path("b")],
        })
    );
    drop(tx);
    assert_eq!(rx.recv().await, None);
}

#[tokio::test]
async fn rescan_supersedes_pending_path_changes() {
    let (tx, mut rx) = watch_channel();
    tx.add_changed_paths(&[path("changed")], Vec::new).await;
    tx.require_rescan(&[path("root-b"), path("root-a")]).await;

    assert_eq!(
        rx.recv().await,
        Some(FileWatcherEvent::RescanRequired {
            watched_paths: vec![path("root-a"), path("root-b")],
        })
    );
}

#[tokio::test]
async fn throttled_receiver_holds_the_next_batch_until_interval() {
    let (tx, rx) = watch_channel();
    let mut rx = ThrottledWatchReceiver::new(rx, COALESCE_INTERVAL);
    tx.add_changed_paths(&[path("a")], Vec::new).await;
    assert_eq!(
        rx.recv().await,
        Some(FileWatcherEvent::PathsChanged {
            paths: vec![path("a")],
        })
    );

    tx.add_changed_paths(&[path("b")], Vec::new).await;
    assert!(timeout(COALESCE_INTERVAL / 2, rx.recv()).await.is_err());
    assert_eq!(
        timeout(COALESCE_INTERVAL * 2, rx.recv()).await.unwrap(),
        Some(FileWatcherEvent::PathsChanged {
            paths: vec![path("b")],
        })
    );
}

#[tokio::test]
async fn debounced_receiver_merges_a_burst() {
    let (tx, rx) = watch_channel();
    let mut rx = DebouncedWatchReceiver::new(rx, COALESCE_INTERVAL);
    tx.add_changed_paths(&[path("c")], Vec::new).await;
    let delayed_tx = tx.clone();
    tokio::spawn(async move {
        tokio::time::sleep(COALESCE_INTERVAL / 2).await;
        delayed_tx.add_changed_paths(&[path("d")], Vec::new).await;
    });

    assert_eq!(
        timeout(COALESCE_INTERVAL * 3, rx.recv()).await.unwrap(),
        Some(FileWatcherEvent::PathsChanged {
            paths: vec![path("c"), path("d")],
        })
    );
}

#[test]
fn registration_ref_counts_and_raii_drop_are_exact() {
    let dir = TestDir::new();
    let root = dir.create_dir("skills");
    let watcher = Arc::new(FileWatcher::noop());
    let (subscriber, _rx) = watcher.add_subscriber();
    let first = subscriber
        .register_paths(vec![
            watch(&root, false),
            watch(&root, false),
            watch(&root, true),
        ])
        .unwrap();
    let second = subscriber.register_paths(vec![watch(&root, true)]).unwrap();

    assert_eq!(watcher.watch_counts_for_test(&root), Some((1, 2)));
    drop(first);
    assert_eq!(watcher.watch_counts_for_test(&root), Some((0, 1)));
    drop(second);
    assert_eq!(watcher.watch_counts_for_test(&root), None);
}

#[test]
fn dropping_subscriber_removes_all_its_counts() {
    let dir = TestDir::new();
    let root = dir.create_dir("skills");
    let watcher = Arc::new(FileWatcher::noop());
    let registration = {
        let (subscriber, _rx) = watcher.add_subscriber();
        subscriber.register_paths(vec![watch(&root, true)]).unwrap()
    };

    assert_eq!(watcher.watch_counts_for_test(&root), None);
    drop(registration);
}

#[test]
fn live_watcher_requires_a_current_tokio_runtime() {
    assert!(FileWatcher::new().is_err());
}

#[tokio::test]
async fn ordinary_file_edits_do_not_restart_the_backend() {
    let dir = TestDir::new();
    let file = dir.path.join("gitconfig");
    fs::write(&file, "initial").unwrap();
    let operations = Arc::new(Mutex::new(Vec::new()));
    let watcher = Arc::new(FileWatcher::recording_for_test(Arc::clone(&operations)));
    let (subscriber, mut events) = watcher.add_subscriber();
    let _registration = subscriber
        .register_paths(vec![watch(&file, false)])
        .unwrap();
    let registered = operations.lock().unwrap().clone();
    let (raw_tx, raw_rx) = crate::ingress::event_channel();
    watcher.spawn_event_loop_for_test(raw_rx);
    for edit in 0..6 {
        fs::write(&file, format!("edit {edit}")).unwrap();
        raw_tx
            .send(Ok(notify_event(
                EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                vec![file.clone()],
            )))
            .unwrap();
        assert_eq!(
            timeout(Duration::from_secs(1), events.recv())
                .await
                .unwrap(),
            Some(FileWatcherEvent::PathsChanged {
                paths: vec![file.clone()]
            }),
        );
    }
    let after_edits = operations.lock().unwrap().clone();
    assert_eq!(
        after_edits, registered,
        "writing an existing file must notify its subscriber without destroying and recreating its OS watch"
    );
}

#[test]
fn root_batch_and_its_disposal_each_commit_once() {
    let dir = TestDir::new();
    let roots = (0..32)
        .map(|index| dir.create_dir(index.to_string()))
        .collect::<Vec<_>>();
    let watcher = Arc::new(FileWatcher::recording_for_test(Arc::default()));
    let (subscriber, _events) = watcher.add_subscriber();
    let registration = subscriber
        .register_paths(roots.iter().map(|path| watch(path, true)).collect())
        .unwrap();
    assert_eq!(watcher.backend_commits_for_test(), 1);
    for root in &roots {
        assert_eq!(
            watcher.backend_mode_for_test(root),
            Some(RecursiveMode::Recursive)
        );
    }
    drop(registration);
    assert_eq!(watcher.backend_commits_for_test(), 2);
    assert_eq!(watcher.watch_counts_for_test(&dir.path), None);
}

#[test]
fn missing_target_uses_nearest_existing_directory_non_recursively() {
    let dir = TestDir::new();
    fs::write(dir.path.join("not-a-dir"), "contents").unwrap();
    let missing = dir.path.join("not-a-dir/child/file");
    let watcher = Arc::new(FileWatcher::noop());
    let (subscriber, _rx) = watcher.add_subscriber();
    let _registration = subscriber
        .register_paths(vec![watch(missing, true)])
        .unwrap();

    assert_eq!(watcher.watch_counts_for_test(&dir.path), Some((1, 0)));
}

#[tokio::test]
async fn subscribers_only_receive_matching_paths() {
    let watcher = Arc::new(FileWatcher::noop());
    let (skills, mut skills_rx) = watcher.add_subscriber();
    let (plugins, mut plugins_rx) = watcher.add_subscriber();
    let _skills = skills
        .register_paths(vec![watch("/tmp/ash-skills", true)])
        .unwrap();
    let _plugins = plugins
        .register_paths(vec![watch("/tmp/ash-plugins", true)])
        .unwrap();

    watcher
        .send_paths_for_test(vec![path("/tmp/ash-skills/rust/SKILL.md")])
        .await;

    assert_eq!(
        skills_rx.recv().await,
        Some(FileWatcherEvent::PathsChanged {
            paths: vec![path("/tmp/ash-skills/rust/SKILL.md")],
        })
    );
    assert!(timeout(COALESCE_INTERVAL, plugins_rx.recv()).await.is_err());
}

#[tokio::test]
async fn non_recursive_watch_ignores_grandchildren() {
    let watcher = Arc::new(FileWatcher::noop());
    let (subscriber, mut rx) = watcher.add_subscriber();
    let _registration = subscriber
        .register_paths(vec![watch("/tmp/ash-skills", false)])
        .unwrap();
    watcher
        .send_paths_for_test(vec![path("/tmp/ash-skills/rust/SKILL.md")])
        .await;

    assert!(timeout(COALESCE_INTERVAL, rx.recv()).await.is_err());
}

#[tokio::test]
async fn missing_directory_moves_watch_and_reports_requested_namespace() {
    let dir = TestDir::new();
    let skills = dir.path.join("skills");
    let skill_file = skills.join("SKILL.md");
    let watcher = Arc::new(FileWatcher::noop());
    let (subscriber, mut rx) = watcher.add_subscriber();
    let _registration = subscriber
        .register_paths(vec![watch(&skills, false)])
        .unwrap();
    assert_eq!(watcher.watch_counts_for_test(&dir.path), Some((1, 0)));

    fs::create_dir(&skills).unwrap();
    watcher.send_paths_for_test(vec![dir.path.clone()]).await;
    assert_eq!(
        rx.recv().await,
        Some(FileWatcherEvent::PathsChanged {
            paths: vec![skills.clone()],
        })
    );
    assert_eq!(watcher.watch_counts_for_test(&dir.path), Some((1, 0)));
    assert_eq!(watcher.watch_counts_for_test(&skills), Some((1, 0)));

    fs::write(&skill_file, "name: rust\n").unwrap();
    watcher.send_paths_for_test(vec![skill_file.clone()]).await;
    assert_eq!(
        rx.recv().await,
        Some(FileWatcherEvent::PathsChanged {
            paths: vec![skill_file],
        })
    );
    drop(_registration);
    assert_eq!(watcher.watch_counts_for_test(&dir.path), None);
    assert_eq!(watcher.watch_counts_for_test(&skills), None);
}

#[tokio::test]
async fn live_backend_upgrades_and_downgrades_effective_scope() {
    let dir = TestDir::new();
    let root = dir.create_dir("watched");
    let watcher = Arc::new(FileWatcher::new().unwrap());
    let (subscriber, _rx) = watcher.add_subscriber();
    let non_recursive = subscriber
        .register_paths(vec![watch(&root, false)])
        .unwrap();
    let recursive = subscriber.register_paths(vec![watch(&root, true)]).unwrap();
    assert_eq!(
        watcher.backend_mode_for_test(&root),
        Some(RecursiveMode::Recursive)
    );

    drop(recursive);
    assert_eq!(
        watcher.backend_mode_for_test(&root),
        Some(RecursiveMode::NonRecursive)
    );
    drop(non_recursive);
    assert_eq!(watcher.backend_mode_for_test(&root), None);
}

#[tokio::test]
async fn live_directory_deletion_and_recreation_resume_recursive_notifications() {
    directory_deletion_and_recreation(FileWatcherBackend::Recommended).await;
}

#[tokio::test]
async fn polling_directory_deletion_and_recreation_resume_recursive_notifications() {
    directory_deletion_and_recreation(FileWatcherBackend::Polling {
        interval: Duration::from_millis(20),
    })
    .await;
}

async fn wait_polling_baseline(watcher: &FileWatcher, receiver: &mut crate::channel::Receiver) {
    #[cfg(target_os = "macos")]
    if watcher.is_polling_for_test() {
        timeout(Duration::from_secs(3), async {
            loop {
                if matches!(
                    receiver.recv().await,
                    Some(FileWatcherEvent::RescanRequired { .. })
                ) {
                    break;
                }
            }
        })
        .await
        .expect("polling baseline scan did not complete");
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (watcher, receiver);
}

async fn directory_deletion_and_recreation(backend: FileWatcherBackend) {
    async fn changed(
        watcher: &FileWatcher,
        receiver: &mut crate::channel::Receiver,
        expected: &Path,
        phase: &str,
    ) {
        let mut observed = Vec::new();
        let result = timeout(Duration::from_secs(3), async {
            loop {
                let event = receiver.recv().await.expect("watch subscriber closed");
                observed.push(event.clone());
                match event {
                    FileWatcherEvent::PathsChanged { paths }
                        if paths.iter().any(|path| path == expected) =>
                    {
                        break;
                    }
                    FileWatcherEvent::RescanRequired { watched_paths }
                        if watched_paths.iter().any(|path| expected.starts_with(path)) =>
                    {
                        break;
                    }
                    FileWatcherEvent::PathsChanged { .. }
                    | FileWatcherEvent::RescanRequired { .. } => {}
                }
            }
        })
        .await;
        assert!(
            result.is_ok(),
            "directory watch did not recover during {phase}: {observed:?}; {}",
            watcher.registration_state_for_test()
        );
    }
    let dir = TestDir::new();
    let root = dir.create_dir("recreated");
    let watcher = Arc::new(FileWatcher::new_with_backend(backend).unwrap());
    let (subscriber, mut receiver) = watcher.add_subscriber();
    let _registration = subscriber.register_paths(vec![watch(&root, true)]).unwrap();
    wait_polling_baseline(&watcher, &mut receiver).await;
    fs::remove_dir(&root).unwrap();
    changed(&watcher, &mut receiver, &root, "deletion").await;
    fs::create_dir(&root).unwrap();
    changed(&watcher, &mut receiver, &root, "recreation").await;
    let nested = root.join("nested");
    fs::create_dir(&nested).unwrap();
    let file = nested.join("after.txt");
    fs::write(&file, "restored").unwrap();
    changed(&watcher, &mut receiver, &file, "nested write").await;

    // The event loop must also recover when it never observes the root missing.
    fs::rename(&root, dir.path.join("retired-root")).unwrap();
    fs::create_dir(&root).unwrap();
    // Polling also detects a replacement through removal of the old children when the
    // directory's timestamp has the same second-resolution value in both snapshots.
    let replacement = if watcher.is_polling_for_test() {
        &file
    } else {
        &root
    };
    changed(
        &watcher,
        &mut receiver,
        replacement,
        "immediate replacement",
    )
    .await;
    let nested = root.join("replacement-nested");
    fs::create_dir(&nested).unwrap();
    let file = nested.join("after.txt");
    fs::write(&file, "replacement").unwrap();
    changed(&watcher, &mut receiver, &file, "replacement nested write").await;
}

#[tokio::test]
async fn polling_backend_delivers_live_mutations_for_aliased_path_fallback() {
    let dir = TestDir::new();
    let root = dir.create_dir("watched");
    let watcher = Arc::new(
        FileWatcher::new_with_backend(FileWatcherBackend::Polling {
            interval: Duration::from_millis(20),
        })
        .unwrap(),
    );
    let (subscriber, mut receiver) = watcher.add_subscriber();
    let _registration = subscriber.register_paths(vec![watch(&root, true)]).unwrap();
    wait_polling_baseline(&watcher, &mut receiver).await;
    let changed = root.join("changed.txt");
    fs::write(&changed, "changed").unwrap();

    timeout(Duration::from_secs(2), async {
        loop {
            if let Some(FileWatcherEvent::PathsChanged { paths }) = receiver.recv().await {
                assert!(paths.iter().all(|path| path.starts_with(&root)));
                // A root metadata hint may precede the precise polling event. Require
                // the independently observed file change as well.
                if paths.contains(&changed) {
                    break;
                }
            }
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn polling_backend_delivers_existing_file_modifications() {
    let dir = TestDir::new();
    let root = dir.create_dir("watched");
    let changed = root.join("changed.txt");
    fs::write(&changed, "before").unwrap();
    let modified = fs::metadata(&changed).unwrap().modified().unwrap();
    let watcher = Arc::new(
        FileWatcher::new_with_backend(FileWatcherBackend::Polling {
            interval: Duration::from_millis(20),
        })
        .unwrap(),
    );
    let (subscriber, mut receiver) = watcher.add_subscriber();
    let _registration = subscriber.register_paths(vec![watch(&root, true)]).unwrap();
    wait_polling_baseline(&watcher, &mut receiver).await;
    fs::write(&changed, "after!").unwrap();
    fs::File::options()
        .write(true)
        .open(&changed)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();

    assert_eq!(
        timeout(Duration::from_secs(2), receiver.recv())
            .await
            .unwrap(),
        Some(FileWatcherEvent::PathsChanged {
            paths: vec![changed],
        })
    );
}

#[tokio::test]
async fn polling_ancestors_hash_contents_only_while_explicitly_registered() {
    let dir = TestDir::new();
    let root = dir.create_dir("watched");
    let watcher = Arc::new(
        FileWatcher::new_with_backend(FileWatcherBackend::Polling {
            interval: Duration::from_millis(20),
        })
        .unwrap(),
    );
    let (subscriber, _receiver) = watcher.add_subscriber();
    let _registration = subscriber.register_paths(vec![watch(&root, true)]).unwrap();
    assert_eq!(watcher.backend_contents_for_test(&root), Some(true));
    assert_eq!(watcher.backend_contents_for_test(&dir.path), None);

    let parent = subscriber
        .register_paths(vec![watch(&dir.path, false)])
        .unwrap();
    assert_eq!(watcher.backend_contents_for_test(&dir.path), Some(true));
    drop(parent);
    assert_eq!(watcher.backend_contents_for_test(&dir.path), None);

    let missing = root.join("missing/child");
    let registration = subscriber
        .register_paths(vec![watch(&missing, true)])
        .unwrap();
    drop(_registration);
    assert_eq!(watcher.backend_contents_for_test(&root), Some(false));
    drop(registration);
    assert_eq!(watcher.backend_contents_for_test(&root), None);
}

#[tokio::test]
async fn backend_filters_access_events_and_routes_mutations() {
    let watcher = Arc::new(FileWatcher::noop());
    let (subscriber, mut rx) = watcher.add_subscriber();
    let _registration = subscriber
        .register_paths(vec![watch("/tmp/ash-skills", true)])
        .unwrap();
    let (raw_tx, raw_rx) = crate::ingress::event_channel();
    watcher.spawn_event_loop_for_test(raw_rx);

    raw_tx
        .send(Ok(notify_event(
            EventKind::Access(AccessKind::Open(AccessMode::Any)),
            vec![path("/tmp/ash-skills/SKILL.md")],
        )))
        .unwrap();
    assert!(timeout(COALESCE_INTERVAL, rx.recv()).await.is_err());

    raw_tx
        .send(Ok(notify_event(
            EventKind::Create(CreateKind::File),
            vec![path("/tmp/ash-skills/SKILL.md")],
        )))
        .unwrap();
    assert_eq!(
        rx.recv().await,
        Some(FileWatcherEvent::PathsChanged {
            paths: vec![path("/tmp/ash-skills/SKILL.md")],
        })
    );
}

#[tokio::test]
async fn backend_error_requires_scoped_rescan_for_every_subscriber() {
    let watcher = Arc::new(FileWatcher::noop());
    let (subscriber, mut rx) = watcher.add_subscriber();
    let _registration = subscriber
        .register_paths(vec![
            watch("/tmp/ash-skills", true),
            watch("/tmp/ash-plugins", true),
        ])
        .unwrap();
    let (raw_tx, raw_rx) = crate::ingress::event_channel();
    watcher.spawn_event_loop_for_test(raw_rx);
    raw_tx
        .send(Err(notify::Error::generic("synthetic overflow")))
        .unwrap();

    assert_eq!(
        rx.recv().await,
        Some(FileWatcherEvent::RescanRequired {
            watched_paths: vec![path("/tmp/ash-plugins"), path("/tmp/ash-skills")],
        })
    );
}

#[tokio::test]
async fn backend_rescan_flag_requires_scoped_rescan() {
    let watcher = Arc::new(FileWatcher::noop());
    let (subscriber, mut rx) = watcher.add_subscriber();
    let _registration = subscriber
        .register_paths(vec![watch("/tmp/ash-skills", true)])
        .unwrap();
    let (raw_tx, raw_rx) = crate::ingress::event_channel();
    watcher.spawn_event_loop_for_test(raw_rx);
    raw_tx
        .send(Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan)))
        .unwrap();

    assert_eq!(
        rx.recv().await,
        Some(FileWatcherEvent::RescanRequired {
            watched_paths: vec![path("/tmp/ash-skills")],
        })
    );
}

#[tokio::test]
async fn subscriber_overflow_rescans_owned_roots_and_preserves_future_changes() {
    let dir = TestDir::new();
    let root = dir.create_dir("owned");
    let other = dir.create_dir("unrelated");
    let watcher = Arc::new(FileWatcher::noop());
    let (subscriber, mut receiver) = watcher.add_subscriber();
    let (unrelated, mut unrelated_receiver) = watcher.add_subscriber();
    let _registration = subscriber.register_paths(vec![watch(&root, true)]).unwrap();
    let _unrelated = unrelated.register_paths(vec![watch(&other, true)]).unwrap();
    // Each routed batch is small, but a stalled consumer spans many batches.
    for batch in 0..40 {
        watcher
            .send_paths_for_test(
                (0..128)
                    .map(|index| root.join(format!("generated-{}", batch * 128 + index)))
                    .collect(),
            )
            .await;
    }
    assert_eq!(
        receiver.recv().await,
        Some(FileWatcherEvent::RescanRequired {
            watched_paths: vec![root.clone()]
        })
    );
    assert!(
        timeout(Duration::from_millis(20), unrelated_receiver.recv())
            .await
            .is_err()
    );
    let final_path = root.join("final.txt");
    fs::write(&final_path, "final disk state").unwrap();
    watcher.send_paths_for_test(vec![final_path.clone()]).await;
    assert_eq!(
        receiver.recv().await,
        Some(FileWatcherEvent::PathsChanged {
            paths: vec![final_path.clone()]
        })
    );
    assert_eq!(fs::read_to_string(final_path).unwrap(), "final disk state");
}

static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

struct TestDir {
    path: std::path::PathBuf,
}

impl TestDir {
    fn new() -> Self {
        let sequence = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ash-file-watcher-tests-{}-{}-{sequence}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn create_dir(&self, relative: impl AsRef<Path>) -> std::path::PathBuf {
        let path = self.path.join(relative);
        fs::create_dir_all(&path).unwrap();
        path
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
