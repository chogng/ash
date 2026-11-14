use std::fs;
use std::num::NonZeroUsize;
use std::sync::Arc;

use ash_codebase::Codebase;
use ash_codebase::CodebaseLimits;
use ash_codebase::CodebaseOverlayDocument;
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

#[test]
fn overlays_revert_existing_files_and_handoff_new_files_without_persisting_edits() {
    let (directory, _store, index) = fixture();
    let snapshot = index.snapshot().unwrap();
    let original = fs::read_to_string(directory.path().join("keep.rs")).unwrap();
    let document = |path: &str, editor_revision, content: &str| CodebaseOverlayDocument {
        relative_path: path.into(),
        editor_revision,
        language: ash_language::LanguageId::RUST,
        content: content.into(),
    };
    assert!(
        index
            .synchronize_overlay(document("keep.rs", 1, &original))
            .unwrap()
            .documents
            .is_empty()
    );
    assert_eq!(
        index
            .synchronize_overlay(document("keep.rs", 2, "fn unsaved_keep() {}\n"))
            .unwrap()
            .documents
            .len(),
        1
    );
    assert_eq!(
        index
            .search(&CodebaseQuery::new("unsaved_keep"))
            .unwrap()
            .len(),
        1
    );
    let added = "fn virtual_new() {}\n";
    assert_eq!(
        index
            .synchronize_overlay(document("new.rs", 1, added))
            .unwrap()
            .documents
            .len(),
        2
    );
    assert!(!directory.path().join("new.rs").exists());
    assert_eq!(
        fs::read_to_string(directory.path().join("keep.rs")).unwrap(),
        original
    );
    let reverted = index
        .synchronize_overlay(document("keep.rs", 3, &original))
        .unwrap();
    assert_eq!(reverted.documents.len(), 1);
    assert_eq!(
        reverted.documents[0].source.reference.relative_path,
        Path::new("new.rs")
    );
    assert_eq!(index.snapshot().unwrap(), snapshot);
    fs::write(directory.path().join("new.rs"), added).unwrap();
    index.reconcile().unwrap();
    assert!(
        index
            .handoff_matching_overlays()
            .unwrap()
            .documents
            .is_empty()
    );
    assert_eq!(
        index
            .search(&CodebaseQuery::new("virtual_new"))
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn equivalent_overlay_paths_find_the_same_persistent_revision() {
    let (directory, store, index) = fixture();
    fs::create_dir(directory.path().join("nested")).unwrap();
    let content = "fn nested_file() {}\n";
    fs::write(directory.path().join("nested/file.rs"), content).unwrap();
    index.rebuild().unwrap();
    for path in ["nested/file.rs", "nested//file.rs", "nested/file.rs/"] {
        assert!(
            CodebaseIndexStore::source(store.as_ref(), Path::new(path))
                .unwrap()
                .is_some()
        );
        let overlay = index
            .synchronize_overlay(CodebaseOverlayDocument {
                relative_path: path.into(),
                editor_revision: 1,
                language: ash_language::LanguageId::RUST,
                content: content.into(),
            })
            .unwrap();
        assert!(overlay.documents.is_empty(), "{path}");
    }
}

#[test]
fn cached_inserts_keep_chunk_contents_and_rowids_bound_to_each_source() {
    let directory = tempfile::tempdir().unwrap();
    for name in ["alpha", "beta", "gamma"] {
        let content: String = (0..24).map(|i| format!("marker_{name}_{i}\n")).collect();
        fs::write(directory.path().join(format!("{name}.txt")), content).unwrap();
    }
    let root = Dir::open_local(directory.path()).unwrap();
    let store = Arc::new(
        SqliteCodebaseIndexStore::open(
            &CodebaseStoreStorage::Memory,
            &IndexRootId::from_root(&root),
        )
        .unwrap(),
    );
    let limits = CodebaseLimits::default()
        .with_target_chunk_bytes(NonZeroUsize::new(32).unwrap())
        .with_max_chunk_bytes(NonZeroUsize::new(64).unwrap());
    let index = Codebase::open(root, store, limits).unwrap();
    let first = index.rebuild().unwrap();
    assert!(first.indexed_chunk_count > first.indexed_file_count);
    for name in ["alpha", "beta", "gamma"] {
        for ordinal in [0, 7, 23] {
            let query = format!("marker_{name}_{ordinal}");
            let hits = index.search(&CodebaseQuery::new(&query)).unwrap();
            assert!(!hits.is_empty(), "{query}");
            assert!(hits.iter().all(|hit| hit.reference.relative_path
                == Path::new(&format!("{name}.txt"))
                && hit.content.contains(&query)));
        }
    }
    fs::write(
        directory.path().join("beta.txt"),
        "replacement_beta\n".repeat(24),
    )
    .unwrap();
    index.reconcile().unwrap();
    assert!(
        index
            .search(&CodebaseQuery::new("marker_beta_0"))
            .unwrap()
            .is_empty()
    );
    let replaced = index
        .search(&CodebaseQuery::new("replacement_beta"))
        .unwrap();
    assert!(!replaced.is_empty());
    assert!(
        replaced
            .iter()
            .all(|hit| hit.reference.relative_path == Path::new("beta.txt"))
    );
    assert!(
        !index
            .search(&CodebaseQuery::new("marker_gamma_23"))
            .unwrap()
            .is_empty()
    );
}

#[cfg(any(windows, unix))]
#[test]
fn non_utf8_overlay_paths_do_not_alias_a_lossy_persistent_key() {
    use std::ffi::OsString;
    #[cfg(unix)]
    use std::os::unix::ffi::OsStringExt;
    #[cfg(windows)]
    use std::os::windows::ffi::OsStringExt;

    let (directory, store, index) = fixture();
    let content = "fn replacement_named_file() {}\n";
    fs::write(directory.path().join("\u{fffd}.rs"), content).unwrap();
    index.rebuild().unwrap();
    #[cfg(unix)]
    let mut invalid = OsString::from_vec(vec![0xff]);
    #[cfg(windows)]
    let mut invalid = OsString::from_wide(&[0xd800]);
    invalid.push(".rs");
    let relative_path = PathBuf::from(invalid);
    assert_eq!(relative_path.to_string_lossy(), "\u{fffd}.rs");
    assert!(
        CodebaseIndexStore::source(store.as_ref(), &relative_path)
            .unwrap()
            .is_none()
    );
    let overlay = index
        .synchronize_overlay(CodebaseOverlayDocument {
            relative_path: relative_path.clone(),
            editor_revision: 1,
            language: ash_language::LanguageId::RUST,
            content: content.into(),
        })
        .unwrap();
    assert_eq!(overlay.documents.len(), 1);
    assert_eq!(
        overlay.documents[0].source.reference.relative_path,
        relative_path
    );
}
