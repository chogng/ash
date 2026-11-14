use std::fs;
use std::sync::Arc;

use ash_codebase::Codebase;
use ash_codebase::CodebaseLimits;
use ash_codebase::CodebaseQuery;
use ash_file_access::Dir;
use tempfile::TempDir;

use super::*;

fn fixture() -> (TempDir, Arc<SqliteCodebaseIndexStore>, Codebase) {
    let directory = tempfile::tempdir().unwrap();
    for (path, text) in [
        ("keep.rs", "fn keep() {}\n"),
        ("change.rs", "fn before() {}\n"),
        ("remove.rs", "fn removed() {}\n"),
    ] {
        fs::write(directory.path().join(path), text).unwrap();
    }
    let root = Dir::open_local(directory.path()).unwrap();
    let root_id = IndexRootId::from_root(&root);
    let store =
        Arc::new(SqliteCodebaseIndexStore::open(&CodebaseStoreStorage::Memory, &root_id).unwrap());
    let index = Codebase::open(root, store.clone(), CodebaseLimits::default()).unwrap();
    index.rebuild().unwrap();
    (directory, store, index)
}

#[test]
fn rescan_preserves_unchanged_rows_and_searches_changed_chunks() {
    let (directory, store, index) = fixture();
    let original = index.manifest().unwrap();
    store.connection.lock().unwrap().execute_batch(
        "CREATE TRIGGER keep_chunk_delete BEFORE DELETE ON codebase_chunks WHEN OLD.path = 'keep.rs' \
         BEGIN SELECT RAISE(ABORT, 'unchanged chunks deleted'); END; \
         CREATE TRIGGER keep_chunk_insert BEFORE INSERT ON codebase_chunks WHEN NEW.path = 'keep.rs' \
         BEGIN SELECT RAISE(ABORT, 'unchanged chunks inserted'); END; \
         CREATE TRIGGER keep_file_delete BEFORE DELETE ON codebase_files WHEN OLD.path = 'keep.rs' \
         BEGIN SELECT RAISE(ABORT, 'unchanged file deleted'); END;"
    ).unwrap();
    fs::write(directory.path().join("change.rs"), "fn afterx() {}\n").unwrap();
    fs::write(directory.path().join("added.rs"), "fn added() {}\n").unwrap();
    fs::remove_file(directory.path().join("remove.rs")).unwrap();
    let snapshot = index.reconcile().unwrap();
    assert_eq!(snapshot.generation, original.snapshot.generation + 1);
    assert_eq!(snapshot.indexed_file_count, 3);
    for (query, count) in [
        ("keep", 1),
        ("afterx", 1),
        ("added", 1),
        ("before", 0),
        ("removed", 0),
    ] {
        assert_eq!(
            index.search(&CodebaseQuery::new(query)).unwrap().len(),
            count,
            "{query}"
        );
    }
    assert_eq!(index.reconcile().unwrap(), snapshot);
    let reopened = Codebase::open(index.root().clone(), store, CodebaseLimits::default()).unwrap();
    assert_eq!(reopened.reconcile().unwrap(), snapshot);
    assert_eq!(reopened.manifest().unwrap(), index.manifest().unwrap());
}

#[test]
fn failed_reconciliation_rolls_back_and_stale_generation_is_rejected() {
    let (directory, store, index) = fixture();
    let original = index.manifest().unwrap();
    fs::write(directory.path().join("change.rs"), "fn afterx() {}\n").unwrap();
    fs::write(directory.path().join("zz.rs"), "fn added() {}\n").unwrap();
    store
        .connection
        .lock()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER fail_insert BEFORE INSERT ON codebase_files WHEN NEW.path = 'zz.rs' \
         BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;",
        )
        .unwrap();
    assert!(index.reconcile().is_err());
    assert_eq!(index.manifest().unwrap(), original);
    assert_eq!(
        index.search(&CodebaseQuery::new("before")).unwrap().len(),
        1
    );
    assert!(
        index
            .search(&CodebaseQuery::new("afterx"))
            .unwrap()
            .is_empty()
    );
    store
        .connection
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_insert")
        .unwrap();
    let snapshot = index.reconcile().unwrap();
    assert_eq!(snapshot.generation, original.snapshot.generation + 1);
    let committed = index.manifest().unwrap();
    let stale = SourceReconciliation {
        expected_generation: original.snapshot.generation,
        chunking_policy: committed.snapshot.chunking_policy.clone().unwrap(),
        updates: vec![FileUpdate::Remove("keep.rs".into())],
        skipped_file_count: 0,
        file_limit_hit: false,
        source_bytes_limit_hit: false,
    };
    assert!(CodebaseIndexStore::reconcile_sources(store.as_ref(), index.root_id(), stale).is_err());
    assert_eq!(index.manifest().unwrap(), committed);
}

#[test]
fn legacy_missing_policy_rebuilds_once_then_reuses_the_projection() {
    let (_directory, store, index) = fixture();
    let original = index.manifest().unwrap();
    store
        .connection
        .lock()
        .unwrap()
        .execute(
            "DELETE FROM codebase_metadata WHERE key = 'chunking_policy'",
            [],
        )
        .unwrap();
    assert!(index.snapshot().unwrap().chunking_policy.is_none());
    let updated = index.reconcile().unwrap();
    assert_eq!(updated.generation, original.snapshot.generation + 1);
    assert_eq!(index.manifest().unwrap().chunks, original.chunks);
    assert_eq!(
        index.snapshot().unwrap().chunking_policy,
        original.snapshot.chunking_policy
    );
    assert_eq!(index.reconcile().unwrap(), updated);
}
