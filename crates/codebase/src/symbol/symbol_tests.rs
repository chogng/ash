use std::fs;
use std::num::NonZeroUsize;
use std::path::Path;
use std::sync::Arc;

use crate::Codebase;
use crate::CodebaseLimits;
use crate::CodebaseOverlayDocument;
use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use tempfile::TempDir;

use crate::SymbolIndex;
use crate::SymbolIndexError;
use crate::SymbolIndexLimits;
use crate::SymbolIndexQuery;
use crate::SymbolIndexRefreshOutcome;
use crate::SymbolKind;

fn dir() -> TempDir {
    let directory = tempfile::tempdir().expect("dir");
    fs::create_dir(directory.path().join(".git")).expect("git marker");
    directory
}

fn codebase(directory: &TempDir) -> Arc<Codebase> {
    let index = Codebase::open_memory(
        Dir::open_local(directory.path()).expect("root"),
        CodebaseLimits::default(),
    )
    .expect("Codebase");
    index.rebuild().expect("codebase rebuild");
    Arc::new(index)
}

#[test]
fn reconciles_verified_sources_and_fuzzy_searches_symbols() {
    let directory = dir();
    fs::write(
        directory.path().join("auth.rs"),
        "pub struct UserAuthenticationService;\n\
         pub fn create_session() {}\n",
    )
    .expect("source");
    let index = SymbolIndex::open_memory(codebase(&directory), SymbolIndexLimits::default())
        .expect("symbol index");

    let SymbolIndexRefreshOutcome::Published(snapshot) = index.reconcile().expect("reconcile")
    else {
        panic!("first reconcile must publish");
    };
    assert_eq!(snapshot.indexed_source_count, 1);
    assert_eq!(snapshot.indexed_symbol_count, 2);

    let hits = index
        .search(&SymbolIndexQuery::new("uas"))
        .expect("fuzzy search");
    assert_eq!(hits[0].symbol.name, "UserAuthenticationService");
    assert_eq!(hits[0].symbol.kind, SymbolKind::Struct);
    assert_eq!(hits[0].symbol.reference.relative_path, Path::new("auth.rs"));
    assert!(!hits[0].matched_indices.is_empty());
}

#[test]
fn exact_name_match_outranks_fuzzy_candidates() {
    let directory = dir();
    fs::write(
        directory.path().join("symbols.rs"),
        "fn user() {}\nfn create_user() {}\nfn user_factory() {}\n",
    )
    .expect("source");
    let index = SymbolIndex::open_memory(codebase(&directory), SymbolIndexLimits::default())
        .expect("symbol index");
    index.reconcile().expect("reconcile");

    let hits = index
        .search(&SymbolIndexQuery::new("user"))
        .expect("search");
    assert_eq!(hits[0].symbol.name, "user");
    assert!(hits[0].score > hits[1].score);
}

#[test]
fn reconcile_replaces_changed_and_deleted_source_symbols() {
    let directory = dir();
    let source = directory.path().join("service.rs");
    fs::write(&source, "fn before() {}\n").expect("source");
    let codebase = codebase(&directory);
    let index = SymbolIndex::open_memory(Arc::clone(&codebase), SymbolIndexLimits::default())
        .expect("symbol index");
    index.reconcile().expect("initial reconcile");

    fs::write(&source, "fn after() {}\n").expect("changed source");
    codebase
        .refresh_observed_paths(std::slice::from_ref(&source))
        .expect("codebase refresh");
    index.reconcile().expect("changed reconcile");
    assert!(
        index
            .search(&SymbolIndexQuery::new("before"))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        index.search(&SymbolIndexQuery::new("after")).unwrap()[0]
            .symbol
            .name,
        "after"
    );

    fs::remove_file(&source).expect("remove source");
    codebase
        .refresh_observed_paths(std::slice::from_ref(&source))
        .expect("codebase refresh");
    index.reconcile().expect("deleted reconcile");
    assert!(
        index
            .search(&SymbolIndexQuery::new("after"))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn total_symbol_limit_is_explicit_and_rebuilds_on_the_next_generation() {
    let directory = dir();
    fs::write(
        directory.path().join("many.rs"),
        "fn first() {}\nfn second() {}\nfn third() {}\n",
    )
    .expect("source");
    let codebase = codebase(&directory);
    let limits = SymbolIndexLimits::default()
        .with_max_total_symbols(NonZeroUsize::new(2).expect("non-zero"));
    let index = SymbolIndex::open_memory(codebase, limits).expect("symbol index");
    let SymbolIndexRefreshOutcome::Published(snapshot) = index.reconcile().expect("reconcile")
    else {
        panic!("reconcile must publish");
    };
    assert_eq!(snapshot.indexed_symbol_count, 2);
    assert!(snapshot.symbol_limit_hit);
}

#[test]
fn dirty_overlay_symbols_replace_persistent_symbols_for_the_same_path() {
    let directory = dir();
    fs::write(directory.path().join("service.rs"), "fn disk_name() {}\n").expect("source");
    let codebase = codebase(&directory);
    let index = SymbolIndex::open_memory(Arc::clone(&codebase), SymbolIndexLimits::default())
        .expect("symbol index");
    index.reconcile().expect("persistent reconcile");

    codebase
        .synchronize_overlay(CodebaseOverlayDocument {
            relative_path: "service.rs".into(),
            editor_revision: 2,
            language: crate::IndexedLanguage::Rust,
            content: "fn unsaved_name() {}\n".into(),
        })
        .expect("overlay");

    assert!(
        index
            .search(&SymbolIndexQuery::new("disk_name"))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        index
            .search(&SymbolIndexQuery::new("unsaved_name"))
            .unwrap()[0]
            .symbol
            .name,
        "unsaved_name"
    );

    codebase
        .close_overlay(Path::new("service.rs"))
        .expect("close");
    assert_eq!(
        index.search(&SymbolIndexQuery::new("disk_name")).unwrap()[0]
            .symbol
            .name,
        "disk_name"
    );
}

#[test]
fn cancelled_query_does_not_publish_results() {
    let directory = dir();
    fs::write(directory.path().join("lib.rs"), "fn searchable() {}\n").expect("source");
    let index = SymbolIndex::open_memory(codebase(&directory), SymbolIndexLimits::default())
        .expect("symbol index");
    index.reconcile().expect("reconcile");
    let cancellation = CancellationSource::new();
    cancellation.cancel();

    assert!(matches!(
        index.search_with_cancellation(&SymbolIndexQuery::new("searchable"), &cancellation.token()),
        Err(SymbolIndexError::Cancelled(_))
    ));
}
