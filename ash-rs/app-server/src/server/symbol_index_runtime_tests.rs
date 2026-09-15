use std::fs;
use std::sync::Arc;

use ash_codebase::Codebase;
use ash_codebase::CodebaseLimits;
use ash_codebase::SymbolIndexQuery;
use ash_codebase_store::CodebaseStore;
use ash_file_access::Dir;
use tempfile::TempDir;

use super::SymbolIndexRuntime;
use super::SymbolIndexRuntimeState;

fn dir_fixture() -> TempDir {
    let directory = tempfile::tempdir().expect("directory");
    fs::create_dir(directory.path().join(".git")).expect("git marker");
    directory
}

fn codebase(directory: &TempDir) -> Arc<Codebase> {
    let index = Codebase::open_memory(
        Dir::open_local(directory.path()).expect("directory root"),
        CodebaseLimits::default(),
    )
    .expect("Codebase");
    index.rebuild().expect("codebase rebuild");
    Arc::new(index)
}

#[test]
fn reconcile_publishes_a_searchable_generation() {
    let directory = dir_fixture();
    fs::write(directory.path().join("lib.rs"), "pub fn searchable() {}\n").expect("source");
    let runtime = SymbolIndexRuntime::open(codebase(&directory), Arc::new(CodebaseStore::memory()))
        .expect("symbol-index runtime");

    assert_eq!(runtime.state(), SymbolIndexRuntimeState::Empty);
    let snapshot = runtime.reconcile().expect("reconcile");
    assert_eq!(snapshot.indexed_symbol_count, 1);
    assert!(matches!(runtime.state(), SymbolIndexRuntimeState::Ready(_)));
    assert_eq!(
        runtime
            .search(&SymbolIndexQuery::new("searchable"))
            .unwrap()[0]
            .symbol
            .name,
        "searchable"
    );
}

#[test]
fn search_marks_a_projection_stale_after_source_generation_changes() {
    let directory = dir_fixture();
    let source = directory.path().join("lib.rs");
    fs::write(&source, "pub fn before() {}\n").expect("source");
    let codebase = codebase(&directory);
    let runtime =
        SymbolIndexRuntime::open(Arc::clone(&codebase), Arc::new(CodebaseStore::memory()))
            .expect("symbol-index runtime");
    runtime.reconcile().expect("initial reconcile");

    fs::write(&source, "pub fn after() {}\n").expect("changed source");
    codebase
        .refresh_observed_paths(&[source])
        .expect("codebase refresh");
    let _ = runtime.search(&SymbolIndexQuery::new("before"));

    assert!(matches!(runtime.state(), SymbolIndexRuntimeState::Stale(_)));
}
