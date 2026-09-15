use super::*;
use ash_state::StateRuntime;
use std::fs;
use tempfile::TempDir;

fn dir_fixture() -> TempDir {
    let directory = tempfile::tempdir().expect("directory");
    fs::create_dir(directory.path().join(".git")).expect("git marker");
    directory
}

#[test]
fn search_revalidates_content_and_marks_a_lagging_projection_stale() {
    let directory = dir_fixture();
    let source_path = directory.path().join("lib.rs");
    fs::write(&source_path, "pub fn before_watcher() {}\n").expect("source");
    let runtime = CodebaseRuntime::open(
        Dir::open_local(directory.path()).expect("root"),
        Arc::new(CodebaseStore::memory()),
        None,
    )
    .expect("runtime");
    runtime.rebuild().expect("rebuild");

    fs::write(&source_path, "pub fn after_watcher() {}\n").expect("changed source");
    let error = runtime
        .search(&CodebaseQuery::new("before_watcher"))
        .expect_err("stale result must be rejected");

    assert!(matches!(
        error,
        CodebaseRuntimeError::Index(CodebaseError::StaleRevision { .. })
    ));
    assert!(matches!(runtime.state(), CodebaseRuntimeState::Stale(_)));
}

#[test]
fn reopened_index_remains_stale_until_the_dir_is_reconciled() {
    let directory = dir_fixture();
    fs::write(directory.path().join("lib.rs"), "pub fn persisted() {}\n").expect("source");
    let state = tempfile::tempdir().expect("state");
    let state = StateRuntime::open(state.path()).expect("state runtime");
    let root = Dir::open_local(directory.path()).expect("root");
    let runtime = CodebaseRuntime::open(
        root.clone(),
        Arc::new(CodebaseStore::open(&state, &root.id()).expect("store")),
        None,
    )
    .expect("runtime");
    runtime.rebuild().expect("rebuild");
    drop(runtime);

    let reopened = CodebaseRuntime::open(
        root.clone(),
        Arc::new(CodebaseStore::open(&state, &root.id()).expect("reopen store")),
        None,
    )
    .expect("reopen");
    assert!(matches!(reopened.state(), CodebaseRuntimeState::Stale(_)));
    reopened.rebuild().expect("reconcile");
    assert!(matches!(reopened.state(), CodebaseRuntimeState::Ready(_)));
}

#[test]
fn irrelevant_watcher_hint_returns_runtime_to_ready_without_a_generation_change() {
    let directory = dir_fixture();
    fs::write(directory.path().join("lib.rs"), "pub fn current() {}\n").expect("source");
    fs::create_dir(directory.path().join(".ash")).expect("runtime directory");
    let runtime_path = directory.path().join(".ash/runtime.json");
    fs::write(&runtime_path, "{}\n").expect("runtime source");
    let runtime = CodebaseRuntime::open(
        Dir::open_local(directory.path()).expect("root"),
        Arc::new(CodebaseStore::memory()),
        None,
    )
    .expect("runtime");
    let before = runtime.rebuild().expect("rebuild");

    runtime.apply_watcher_event(&FileWatcherEvent::PathsChanged {
        paths: vec![runtime_path],
    });

    let CodebaseRuntimeState::Ready(after) = runtime.state() else {
        panic!("irrelevant hint should restore ready state");
    };
    assert_eq!(after.generation, before.generation);
}

#[test]
fn irrelevant_watcher_hint_does_not_clear_a_stale_projection() {
    let directory = dir_fixture();
    fs::write(directory.path().join("lib.rs"), "pub fn persisted() {}\n").expect("source");
    fs::create_dir(directory.path().join(".ash")).expect("runtime directory");
    let runtime_path = directory.path().join(".ash/runtime.json");
    fs::write(&runtime_path, "{}\n").expect("runtime source");
    let state = tempfile::tempdir().expect("state");
    let state = StateRuntime::open(state.path()).expect("state runtime");
    let root = Dir::open_local(directory.path()).expect("root");
    let runtime = CodebaseRuntime::open(
        root.clone(),
        Arc::new(CodebaseStore::open(&state, &root.id()).expect("store")),
        None,
    )
    .expect("runtime");
    runtime.rebuild().expect("rebuild");
    drop(runtime);

    let reopened = CodebaseRuntime::open(
        root.clone(),
        Arc::new(CodebaseStore::open(&state, &root.id()).expect("reopen store")),
        None,
    )
    .expect("reopen");
    reopened.apply_watcher_event(&FileWatcherEvent::PathsChanged {
        paths: vec![runtime_path],
    });

    assert!(matches!(reopened.state(), CodebaseRuntimeState::Stale(_)));
}
