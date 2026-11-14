use std::fs;
use std::sync::Arc;

use ash_codebase::Codebase;
use ash_codebase::CodebaseLimits;
use ash_codebase::SymbolIndex;
use ash_codebase::SymbolIndexLimits;
use ash_file_access::Dir;
use tempfile::TempDir;

use super::*;

fn fixture() -> (
    TempDir,
    Arc<Codebase>,
    Arc<SqliteSymbolIndexStore>,
    SymbolIndex,
) {
    let directory = tempfile::tempdir().unwrap();
    fs::write(directory.path().join("keep.rs"), "fn keep() {}\n").unwrap();
    fs::write(directory.path().join("change.rs"), "fn before() {}\n").unwrap();
    fs::write(directory.path().join("empty.rs"), "// no declarations\n").unwrap();
    let codebase = Arc::new(
        Codebase::open_memory(
            Dir::open_local(directory.path()).unwrap(),
            CodebaseLimits::default(),
        )
        .unwrap(),
    );
    codebase.rebuild().unwrap();
    let store = Arc::new(
        SqliteSymbolIndexStore::open(&CodebaseStoreStorage::Memory, codebase.root_id()).unwrap(),
    );
    let index = SymbolIndex::open(
        Arc::clone(&codebase),
        store.clone(),
        SymbolIndexLimits::default(),
    )
    .unwrap();
    index.reconcile().unwrap();
    (directory, codebase, store, index)
}

#[test]
fn file_update_leaves_unchanged_rows_untouched_and_reopen_matches() {
    let (directory, codebase, store, index) = fixture();
    let manifest = store
        .load_manifest(codebase.root_id())
        .unwrap_or_else(|_| panic!("manifest"));
    assert_eq!(manifest.sources[&PathBuf::from("empty.rs")].symbol_count, 0);
    store.connection.lock().unwrap().execute_batch(
        "CREATE TRIGGER keep_delete BEFORE DELETE ON symbol_index_symbols WHEN OLD.path = 'keep.rs' \
         BEGIN SELECT RAISE(ABORT, 'unchanged symbols were deleted'); END; \
         CREATE TRIGGER keep_insert BEFORE INSERT ON symbol_index_symbols WHEN NEW.path = 'keep.rs' \
         BEGIN SELECT RAISE(ABORT, 'unchanged symbols were inserted'); END; \
         CREATE TRIGGER keep_file_delete BEFORE DELETE ON symbol_index_files WHEN OLD.path = 'keep.rs' \
         BEGIN SELECT RAISE(ABORT, 'unchanged file was deleted'); END;"
    ).unwrap();
    fs::write(directory.path().join("change.rs"), "fn after() {}\n").unwrap();
    fs::remove_file(directory.path().join("empty.rs")).unwrap();
    codebase.rebuild().unwrap();
    index.reconcile().unwrap();
    let snapshot = index.snapshot().unwrap();
    assert_eq!(snapshot.generation, 2);
    assert_eq!(snapshot.indexed_source_count, 2);
    assert_eq!(snapshot.indexed_symbol_count, 2);
    let reopened =
        SymbolIndex::open(Arc::clone(&codebase), store, SymbolIndexLimits::default()).unwrap();
    for query in ["keep", "after", "before", ""] {
        let query = ash_codebase::SymbolIndexQuery::new(query);
        assert_eq!(
            index.search(&query).unwrap(),
            reopened.search(&query).unwrap()
        );
    }
}

#[test]
fn failed_delta_rolls_back_and_cached_statements_can_be_retried() {
    let (_directory, codebase, store, index) = fixture();
    let original = store
        .load_projection(codebase.root_id())
        .unwrap_or_else(|_| panic!("projection"));
    let source = original.sources[&PathBuf::from("change.rs")].clone();
    let mut invalid = source.clone();
    invalid.symbols.push(invalid.symbols[0].clone());
    let update = SymbolProjectionUpdate {
        expected_generation: 1,
        source_generation: 1,
        removed: &[],
        changed: &[invalid],
        symbol_limit_hit: false,
    };
    assert!(
        SymbolIndexStore::update_projection(store.as_ref(), codebase.root_id(), update).is_err()
    );
    assert_eq!(
        store
            .snapshot(codebase.root_id())
            .unwrap_or_else(|_| panic!("snapshot")),
        original.snapshot
    );
    let source_path = source.source.relative_path.clone();
    let valid = SymbolProjectionUpdate {
        expected_generation: 1,
        source_generation: 1,
        removed: &[],
        changed: &[source.clone()],
        symbol_limit_hit: false,
    };
    let snapshot =
        SymbolIndexStore::update_projection(store.as_ref(), codebase.root_id(), valid).unwrap();
    assert_eq!(snapshot.generation, 2);
    let stale = SymbolProjectionUpdate {
        expected_generation: 1,
        source_generation: 1,
        removed: &[source_path],
        changed: &[],
        symbol_limit_hit: false,
    };
    assert!(
        SymbolIndexStore::update_projection(store.as_ref(), codebase.root_id(), stale).is_err()
    );
    assert_eq!(
        store
            .snapshot(codebase.root_id())
            .unwrap_or_else(|_| panic!("snapshot")),
        snapshot
    );
    // The still-open reader rebases if another publisher has already advanced storage.
    index.reconcile().unwrap();
    assert_eq!(index.snapshot().unwrap(), snapshot);
}
