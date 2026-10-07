use super::*;
use std::path::PathBuf;

#[test]
fn changed_paths_are_sorted_and_dir_relative() {
    let directory = tempfile::tempdir().unwrap();
    let root = Dir::open_local(directory.path()).unwrap();
    let projected = project_event(
        &root,
        None,
        FileWatcherEvent::PathsChanged {
            paths: vec![
                root.requested_path().join("src/main.rs"),
                directory
                    .path()
                    .parent()
                    .unwrap()
                    .join("outside/ignored.rs"),
                root.canonical_path().join("README.md"),
                root.requested_path().join("src/main.rs"),
            ],
        },
    );

    assert_eq!(
        projected,
        Some(FsChanged::PathsChanged {
            dir_id: None,
            paths: vec![PathBuf::from("README.md"), PathBuf::from("src/main.rs")],
        }),
    );
}

#[test]
fn watcher_overflow_becomes_a_root_scoped_rescan_hint() {
    let directory = tempfile::tempdir().unwrap();
    let root = Dir::open_local(directory.path()).unwrap();
    let projected = project_event(
        &root,
        None,
        FileWatcherEvent::RescanRequired {
            watched_paths: vec![root.requested_path().to_path_buf()],
        },
    );

    assert_eq!(projected, Some(FsChanged::RescanRequired { dir_id: None }));
}

#[test]
fn codebase_refresh_queue_coalesces_paths_and_rescan_dominates() {
    let mut pending = PendingIndexRefresh::None;
    pending.merge(FileWatcherEvent::PathsChanged {
        paths: vec![PathBuf::from("b.rs"), PathBuf::from("a.rs")],
    });
    pending.merge(FileWatcherEvent::PathsChanged {
        paths: vec![PathBuf::from("c.rs"), PathBuf::from("a.rs")],
    });
    assert_eq!(
        pending.take_event(),
        Some(FileWatcherEvent::PathsChanged {
            paths: vec![
                PathBuf::from("a.rs"),
                PathBuf::from("b.rs"),
                PathBuf::from("c.rs")
            ],
        })
    );

    pending.merge(FileWatcherEvent::PathsChanged {
        paths: vec![PathBuf::from("before.rs")],
    });
    pending.merge(FileWatcherEvent::RescanRequired {
        watched_paths: vec![PathBuf::from("dir")],
    });
    pending.merge(FileWatcherEvent::PathsChanged {
        paths: vec![PathBuf::from("after.rs")],
    });
    assert!(matches!(
        pending.take_event(),
        Some(FileWatcherEvent::RescanRequired { .. })
    ));
}
