use super::*;
use crate::channel::watch_channel;
use notify::Event;
use notify::EventKind;
use notify::RecursiveMode;
use notify::event::AccessKind;
use notify::event::AccessMode;
use notify::event::CreateKind;
use notify::event::Flag;
use pretty_assertions::assert_eq;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use tokio::sync::mpsc;
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
    tx.add_changed_paths(&[path("b"), path("a"), path("b")])
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
    tx.add_changed_paths(&[path("changed")]).await;
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
    tx.add_changed_paths(&[path("a")]).await;
    assert_eq!(
        rx.recv().await,
        Some(FileWatcherEvent::PathsChanged {
            paths: vec![path("a")],
        })
    );

    tx.add_changed_paths(&[path("b")]).await;
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
    tx.add_changed_paths(&[path("c")]).await;
    let delayed_tx = tx.clone();
    tokio::spawn(async move {
        tokio::time::sleep(COALESCE_INTERVAL / 2).await;
        delayed_tx.add_changed_paths(&[path("d")]).await;
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
    assert_eq!(watcher.watch_counts_for_test(&dir.path), None);
    assert_eq!(watcher.watch_counts_for_test(&skills), Some((1, 0)));

    fs::write(&skill_file, "name: rust\n").unwrap();
    watcher.send_paths_for_test(vec![skill_file.clone()]).await;
    assert_eq!(
        rx.recv().await,
        Some(FileWatcherEvent::PathsChanged {
            paths: vec![skill_file],
        })
    );
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
    tokio::time::sleep(Duration::from_millis(40)).await;
    let changed = root.join("changed.txt");
    fs::write(&changed, "changed").unwrap();

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
async fn polling_backend_delivers_existing_file_modifications() {
    let dir = TestDir::new();
    let root = dir.create_dir("watched");
    let changed = root.join("changed.txt");
    fs::write(&changed, "before").unwrap();
    let watcher = Arc::new(
        FileWatcher::new_with_backend(FileWatcherBackend::Polling {
            interval: Duration::from_millis(20),
        })
        .unwrap(),
    );
    let (subscriber, mut receiver) = watcher.add_subscriber();
    let _registration = subscriber.register_paths(vec![watch(&root, true)]).unwrap();
    tokio::time::sleep(Duration::from_millis(40)).await;
    fs::write(&changed, "after").unwrap();

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
async fn backend_filters_access_events_and_routes_mutations() {
    let watcher = Arc::new(FileWatcher::noop());
    let (subscriber, mut rx) = watcher.add_subscriber();
    let _registration = subscriber
        .register_paths(vec![watch("/tmp/ash-skills", true)])
        .unwrap();
    let (raw_tx, raw_rx) = mpsc::unbounded_channel();
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
    let (raw_tx, raw_rx) = mpsc::unbounded_channel();
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
    let (raw_tx, raw_rx) = mpsc::unbounded_channel();
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
