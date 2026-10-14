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
