use super::*;
use ash_codebase::CodebaseLimits;
use ash_codebase::CodebaseSemanticService;
use ash_codebase::EmbeddingIndexKey;
use ash_codebase::InMemoryCodebaseVectorStore;
use ash_codebase_store::CodebaseStore;
use ash_model_provider::EmbeddingInvoker;
use ash_model_provider::EmbeddingRequest;
use ash_model_provider::EmbeddingResponse;
use ash_model_provider::EmbeddingVector;
use ash_model_provider::ModelProviderError;
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

struct StartupEmbedding;

impl EmbeddingInvoker for StartupEmbedding {
    fn embed(&self, request: &EmbeddingRequest) -> Result<EmbeddingResponse, ModelProviderError> {
        EmbeddingResponse::new(
            request
                .inputs()
                .iter()
                .map(|_| EmbeddingVector::new(vec![1.0]))
                .collect::<Result<Vec<_>, _>>()?,
        )
    }
}

#[test]
fn codebase_rescan_initializes_missing_vectors_without_republishing_cached_sources() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(
        directory.path().join("lib.rs"),
        "pub fn cached_source() {}\n",
    )
    .unwrap();
    let root = Dir::open_local(directory.path()).unwrap();
    let store = Arc::new(CodebaseStore::memory());
    let cached = store
        .open_codebase(root.clone(), CodebaseLimits::default())
        .unwrap();
    let initial = cached.rebuild().unwrap();
    let runtime = CodebaseRuntime::open(root, Arc::clone(&store), None).unwrap();
    let symbols = SymbolIndexRuntime::open(runtime.index(), store).unwrap();
    let semantic = CodebaseSemanticService::new(
        runtime.index(),
        EmbeddingIndexKey::new("startup-test").unwrap(),
        Arc::new(StartupEmbedding),
        Arc::new(InMemoryCodebaseVectorStore::default()),
    );
    let job = SemanticIndexJobController::start(Arc::new(semantic)).unwrap();
    assert_eq!(job.snapshot().state, SemanticIndexJobState::Idle);
    let worker = CodebaseRefreshWorker::start(
        Arc::clone(&runtime),
        Arc::clone(&symbols),
        Some(Arc::clone(&job)),
    )
    .unwrap();
    worker.schedule(FileWatcherEvent::RescanRequired {
        watched_paths: vec![],
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while job.snapshot().state != SemanticIndexJobState::Ready {
        assert!(
            std::time::Instant::now() < deadline,
            "startup vector sync did not finish: {:?}",
            job.snapshot()
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        runtime.state(),
        CodebaseRuntimeState::Ready(initial.clone())
    );
    assert_eq!(
        job.snapshot().published_generation,
        Some(initial.generation)
    );
    assert_eq!(
        symbols.index().snapshot().unwrap().source_generation,
        initial.generation
    );
}

#[test]
fn browser_workspace_exact_configuration_watcher_never_publishes_sibling_names_or_directory_rescans()
 {
    let path = PathBuf::from("team.ash-workspace");
    let dir_id = Some("configuration".into());
    assert_eq!(
        project_exact_file_event(
            &path,
            FsChanged::PathsChanged {
                dir_id: dir_id.clone(),
                paths: vec!["secret.txt".into()]
            }
        ),
        None
    );
    let expected = Some(FsChanged::PathsChanged {
        dir_id: dir_id.clone(),
        paths: vec![path.clone()],
    });
    assert_eq!(
        project_exact_file_event(
            &path,
            FsChanged::PathsChanged {
                dir_id: dir_id.clone(),
                paths: vec!["secret.txt".into(), path.clone()]
            }
        ),
        expected
    );
    assert_eq!(
        project_exact_file_event(&path, FsChanged::RescanRequired { dir_id }),
        expected
    );
}

#[test]
fn codebase_refresh_backlog_is_bounded_for_a_stalled_scanner() {
    let mut pending = PendingIndexRefresh::None;
    for index in 0..100_000 {
        pending.merge(FileWatcherEvent::PathsChanged {
            paths: vec![PathBuf::from(format!("generated/{index}.rs"))],
        });
        if let PendingIndexRefresh::Paths { paths, bytes } = &pending {
            assert!(paths.len() <= MAX_INDEX_REFRESH_PATHS);
            assert!(*bytes <= MAX_INDEX_REFRESH_BYTES);
        }
    }
    assert!(matches!(
        pending.take_event(),
        Some(FileWatcherEvent::RescanRequired { .. })
    ));
    pending.merge(FileWatcherEvent::PathsChanged {
        paths: vec![PathBuf::from("last.rs")],
    });
    assert_eq!(
        pending.take_event(),
        Some(FileWatcherEvent::PathsChanged {
            paths: vec![PathBuf::from("last.rs")]
        })
    );
    pending.merge(FileWatcherEvent::PathsChanged {
        paths: vec![PathBuf::from("x".repeat(MAX_INDEX_REFRESH_BYTES + 1))],
    });
    assert!(matches!(
        pending.take_event(),
        Some(FileWatcherEvent::RescanRequired { .. })
    ));
}

#[test]
fn codebase_rescan_storm_cools_down_and_publishes_final_disk_state() {
    let directory = tempfile::tempdir().unwrap();
    let first = directory.path().join("first.rs");
    let second = directory.path().join("second.rs");
    std::fs::write(&first, "pub fn first() {}\n").unwrap();
    let root = Dir::open_local(directory.path()).unwrap();
    let store = Arc::new(CodebaseStore::memory());
    let runtime = CodebaseRuntime::open(root, Arc::clone(&store), None).unwrap();
    let symbols = SymbolIndexRuntime::open(runtime.index(), store).unwrap();
    let worker = CodebaseRefreshWorker::start(Arc::clone(&runtime), symbols, None).unwrap();
    let rescan = || FileWatcherEvent::RescanRequired {
        watched_paths: vec![directory.path().to_path_buf()],
    };
    worker.schedule(rescan());
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !matches!(runtime.state(), CodebaseRuntimeState::Ready(_)) {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    let initial = runtime.index().snapshot().unwrap();
    assert_eq!(initial.indexed_file_count, 1);
    std::fs::write(&second, "pub fn intermediate() {}\n").unwrap();
    for _ in 0..1000 {
        worker.schedule(rescan());
    }
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        runtime.index().snapshot().unwrap().generation,
        initial.generation,
        "full rescans must wait for the completion-based cooldown"
    );
    // Mutations during the cooldown are covered by the one pending scan.
    std::fs::remove_file(&first).unwrap();
    let final_content = "pub fn final_disk_state() {}\n";
    std::fs::write(&second, final_content).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let snapshot = runtime.index().snapshot().unwrap();
        if snapshot.generation > initial.generation {
            assert_eq!(snapshot.indexed_file_count, 1);
            assert_eq!(snapshot.indexed_source_bytes, final_content.len());
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "pending rescan never converged"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    worker.schedule(rescan());
    let stopping = std::time::Instant::now();
    drop(worker);
    assert!(
        stopping.elapsed() < Duration::from_millis(500),
        "shutdown must interrupt the cooldown"
    );
}
