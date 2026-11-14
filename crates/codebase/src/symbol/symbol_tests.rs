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
fn unchanged_generation_does_not_reload_symbol_payloads() {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use crate::IndexRootId;
    use crate::SourceSymbols;
    use crate::StoredSymbolProjection;
    use crate::SymbolIndexSnapshot;
    use crate::SymbolIndexStore;
    use crate::symbol::memory_store::InMemorySymbolIndexStore;

    struct CountingStore {
        inner: InMemorySymbolIndexStore,
        loads: AtomicUsize,
    }
    impl SymbolIndexStore for CountingStore {
        fn snapshot(&self, root: &IndexRootId) -> Result<SymbolIndexSnapshot, SymbolIndexError> {
            self.inner.snapshot(root)
        }
        fn load_projection(
            &self,
            root: &IndexRootId,
        ) -> Result<StoredSymbolProjection, SymbolIndexError> {
            self.loads.fetch_add(1, Ordering::Relaxed);
            self.inner.load_projection(root)
        }
        fn replace_projection(
            &self,
            root: &IndexRootId,
            generation: u64,
            sources: &[SourceSymbols],
            limited: bool,
        ) -> Result<SymbolIndexSnapshot, SymbolIndexError> {
            self.inner
                .replace_projection(root, generation, sources, limited)
        }
    }

    let directory = dir();
    let content = (0..100)
        .map(|i| format!("pub fn symbol_{i}() {{}}\n"))
        .collect::<String>();
    for i in 0..100 {
        fs::write(directory.path().join(format!("source_{i}.rs")), &content).unwrap();
    }
    let codebase = codebase(&directory);
    let store = Arc::new(CountingStore {
        inner: InMemorySymbolIndexStore::new(codebase.root_id().clone()),
        loads: AtomicUsize::new(0),
    });
    let index = SymbolIndex::open(
        codebase.clone(),
        store.clone(),
        SymbolIndexLimits::default(),
    )
    .unwrap();
    assert_eq!(
        store.loads.load(Ordering::Relaxed),
        1,
        "opening prepares the compact matcher"
    );
    index.reconcile().unwrap();
    let loads = store.loads.load(Ordering::Relaxed);
    let started = std::time::Instant::now();
    for _ in 0..3 {
        assert!(matches!(
            index.reconcile().unwrap(),
            SymbolIndexRefreshOutcome::NoChange
        ));
    }
    eprintln!(
        "unchanged reconciliation, 10,000 symbols x 3: {:?}",
        started.elapsed()
    );
    assert_eq!(
        store.loads.load(Ordering::Relaxed),
        loads,
        "unchanged generations must not materialize symbol rows"
    );
    let first_search = std::time::Instant::now();
    assert_eq!(
        index.search(&SymbolIndexQuery::new("symbol_99")).unwrap()[0]
            .symbol
            .name,
        "symbol_99"
    );
    eprintln!(
        "first symbol search, 10,000 symbols: {:?}",
        first_search.elapsed()
    );
    assert_eq!(store.loads.load(Ordering::Relaxed), loads);
    index.search(&SymbolIndexQuery::new("symbol_98")).unwrap();
    assert_eq!(
        store.loads.load(Ordering::Relaxed),
        loads,
        "first and repeated searches use the prepared matcher without storage reads"
    );
    fs::write(
        directory.path().join("added.rs"),
        "pub fn newly_added() {}\n",
    )
    .unwrap();
    codebase.rebuild().unwrap();
    assert!(matches!(
        index.reconcile().unwrap(),
        SymbolIndexRefreshOutcome::Published(_)
    ));
    assert_eq!(
        index.search(&SymbolIndexQuery::new("newly_added")).unwrap()[0]
            .symbol
            .name,
        "newly_added"
    );
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
fn compact_candidates_preserve_each_files_identity_ranges_and_unicode() {
    use crate::SourceSymbols;
    use crate::symbol::extractor::extract_source;
    use crate::symbol::matcher::SymbolMatcher;

    let directory = dir();
    fs::write(directory.path().join("first.rs"), "pub fn café() {}\n").unwrap();
    fs::write(
        directory.path().join("second.rs"),
        "// 😀 different revision and range\npub fn café() { let value = 42; }\n",
    )
    .unwrap();
    let codebase = codebase(&directory);
    let manifest = codebase.manifest().unwrap();
    let materialized = codebase.materialize_sources(&manifest.sources).unwrap();
    let sources: Vec<_> = materialized
        .iter()
        .map(|source| {
            let mut extracted = extract_source(source, 100).unwrap();
            for symbol in &mut extracted.symbols {
                symbol.container_name = Some("container".into());
            }
            SourceSymbols {
                source: source.reference.clone(),
                symbols: extracted.symbols,
                symbol_limit_hit: false,
            }
        })
        .collect();
    let expected = sources.clone();
    let mut matcher = SymbolMatcher::new(sources, 2);
    let cancellation = CancellationSource::new();
    cancellation.cancel();
    assert!(matches!(
        matcher.search("café", 10, &cancellation.token()),
        Err(SymbolIndexError::Cancelled(_))
    ));
    let active = CancellationSource::new();
    let hits = matcher.search("café", 10, &active.token()).unwrap();
    assert_eq!(hits.len(), 2);
    for hit in hits {
        let source = expected
            .iter()
            .find(|source| source.source.relative_path == hit.symbol.reference.relative_path)
            .unwrap();
        let declaration = &source.symbols[hit.symbol.reference.ordinal];
        assert_eq!(hit.symbol.reference.root_id, source.source.root_id);
        assert_eq!(
            hit.symbol.reference.source_revision,
            source.source.source_revision
        );
        assert_eq!(hit.symbol.reference.language, source.source.language);
        assert_eq!(
            hit.symbol.reference.source_bytes,
            source.source.source_bytes
        );
        assert_eq!(
            hit.symbol.reference.declaration_range,
            declaration.declaration_range
        );
        assert_eq!(
            hit.symbol.reference.selection_range,
            declaration.selection_range
        );
        assert_eq!(hit.symbol.name, declaration.name);
        assert_eq!(hit.symbol.kind, declaration.kind);
        assert_eq!(hit.symbol.container_name, declaration.container_name);
        assert_eq!(hit.matched_indices, vec![0, 1, 2, 3]);
    }
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
            language: ash_language::LanguageId::RUST,
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
