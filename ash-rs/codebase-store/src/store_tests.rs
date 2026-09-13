use std::num::NonZeroUsize;
use std::sync::Arc;

use tempfile::TempDir;
use ash_codebase::{
    CodebaseLimits, CodebaseQuery, EmbeddedCodeChunk, EmbeddingIndexKey, SymbolIndexLimits,
    SymbolIndexQuery, SymbolIndexRefreshOutcome,
};
use ash_file_access::Dir;
use ash_model_provider::EmbeddingVector;
use ash_state::StateRuntime;

use crate::CodebaseStore;

fn dir() -> TempDir {
    let directory = tempfile::tempdir().expect("dir");
    std::fs::create_dir(directory.path().join(".git")).expect("git marker");
    std::fs::write(
        directory.path().join("lib.rs"),
        "pub fn persisted_codebase_symbol() {}\n",
    )
    .expect("source");
    directory
}

#[test]
fn one_database_reopens_source_symbol_and_vector_generations() {
    let dir = dir();
    let profile = tempfile::tempdir().expect("profile");
    let state = StateRuntime::open(profile.path()).expect("state");
    let root = Dir::open_local(dir.path()).expect("root");

    let store = Arc::new(CodebaseStore::open(&state, &root.id()).expect("store"));
    let codebase = Arc::new(
        store
            .open_codebase(root.clone(), CodebaseLimits::default())
            .expect("codebase"),
    );
    codebase.rebuild().expect("source generation");
    let symbols = store
        .open_symbol_index(Arc::clone(&codebase), SymbolIndexLimits::default())
        .expect("symbols");
    assert!(matches!(
        symbols.reconcile().expect("symbol generation"),
        SymbolIndexRefreshOutcome::Published(_)
    ));
    let source_hit = codebase
        .search(&CodebaseQuery::new("persisted_codebase_symbol"))
        .expect("source search")
        .pop()
        .expect("source hit");
    let model = EmbeddingIndexKey::new("store-test-v1").expect("model key");
    let vector = EmbeddingVector::new(vec![1.0, 0.0]).expect("embedding");
    let vector_store = store.open_vector_store().expect("vector store");
    vector_store
        .replace_generation(
            codebase.root_id(),
            1,
            &model,
            vec![EmbeddedCodeChunk {
                reference: source_hit.reference,
                language: source_hit.language,
                content: source_hit.content,
                embedding: vector.clone(),
            }],
        )
        .expect("vector generation");
    #[cfg(unix)]
    let database = store.database_path().expect("database").to_path_buf();
    drop(vector_store);
    drop(symbols);
    drop(codebase);
    drop(store);

    let reopened_store =
        Arc::new(CodebaseStore::open(&state, &root.id()).expect("reopened Codebase store"));
    let reopened = Arc::new(
        reopened_store
            .open_codebase(root, CodebaseLimits::default())
            .expect("reopened Codebase"),
    );
    assert_eq!(reopened.snapshot().expect("snapshot").generation, 1);
    assert_eq!(
        reopened
            .search(&CodebaseQuery::new("persisted_codebase_symbol"))
            .expect("source search")
            .len(),
        1
    );
    let reopened_symbols = reopened_store
        .open_symbol_index(Arc::clone(&reopened), SymbolIndexLimits::default())
        .expect("reopened symbols");
    assert_eq!(
        reopened_symbols.reconcile().expect("same generation"),
        SymbolIndexRefreshOutcome::NoChange
    );
    assert_eq!(
        reopened_symbols
            .search(&SymbolIndexQuery::new("persisted_codebase_symbol"))
            .expect("symbol search")[0]
            .symbol
            .name,
        "persisted_codebase_symbol"
    );
    let reopened_vectors = reopened_store
        .open_vector_store()
        .expect("reopened vectors");
    assert_eq!(
        reopened_vectors
            .published_generation(reopened.root_id(), &model)
            .expect("vector generation"),
        Some(1)
    );
    assert_eq!(
        reopened_vectors
            .search(
                reopened.root_id(),
                1,
                &model,
                &vector,
                NonZeroUsize::new(1).expect("limit"),
            )
            .expect("vector search")[0]
            .chunk
            .reference
            .relative_path,
        std::path::PathBuf::from("lib.rs")
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(database)
                .expect("database metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
