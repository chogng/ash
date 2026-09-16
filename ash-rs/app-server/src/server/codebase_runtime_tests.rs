use super::*;
use ash_state::StateRuntime;
use std::fs;
use tempfile::TempDir;

struct GrepCandidates(Mutex<Vec<grep::Match>>);

impl grep::Search for GrepCandidates {
    fn search(
        &self,
        _: &Dir,
        query: &grep::Query,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<grep::SearchResult, grep::Error> {
        assert_eq!(query.pattern, grep::Pattern::Literal);
        Ok(grep::SearchResult {
            matches: self.0.lock().unwrap().clone(),
            limit_hit: false,
            freshness: grep::Freshness::Indexed,
        })
    }
}

fn grep_candidate() -> grep::Match {
    grep::Match {
        path: "lib.rs".into(),
        line_number: 1,
        content: "untrusted needle backend text".into(),
        ranges: vec![grep::MatchRange { start: 10, end: 16 }],
    }
}

#[test]
fn retrieval_uses_grep_candidates_when_sqlite_fts_cannot_match_the_substring() {
    let directory = dir_fixture();
    let source = "pub fn prefixneedlepost() {}\n";
    fs::write(directory.path().join("lib.rs"), source).unwrap();
    let candidates = Arc::new(GrepCandidates(Mutex::new(vec![grep_candidate()])));
    let runtime = CodebaseRuntime::open(
        Dir::open_local(directory.path()).unwrap(),
        Arc::new(CodebaseStore::memory()),
        Some(candidates.clone()),
    )
    .unwrap();
    runtime.rebuild().unwrap();
    let query = CodebaseQuery::new("needle");
    // This is the real SQLite FTS implementation. It cannot supply the positive result.
    assert!(runtime.index().search(&query).unwrap().is_empty());
    let hits = runtime.search(&query).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].content, source);
    assert_eq!(hits[0].reference.relative_path, PathBuf::from("lib.rs"));

    let valid = grep_candidate();
    for invalid in [
        grep::Match {
            ranges: Vec::new(),
            ..valid.clone()
        },
        grep::Match {
            ranges: vec![grep::MatchRange {
                start: 500,
                end: 506,
            }],
            ..valid.clone()
        },
        grep::Match {
            content: "untrusted absent backend text".into(),
            ..valid.clone()
        },
        grep::Match {
            path: "../outside.rs".into(),
            ..valid.clone()
        },
        grep::Match {
            line_number: 999,
            ..valid
        },
    ] {
        *candidates.0.lock().unwrap() = vec![invalid.clone()];
        assert!(
            runtime.search(&query).unwrap().is_empty(),
            "accepted {invalid:?}"
        );
    }
    candidates.0.lock().unwrap().clear();
    assert!(runtime.search(&query).unwrap().is_empty());
}

#[test]
fn retrieval_rejects_stale_grep_locations_and_uses_unsaved_source() {
    let directory = dir_fixture();
    let path = directory.path().join("lib.rs");
    let original = "pub fn prefixneedlepost() {}\n";
    fs::write(&path, original).unwrap();
    let runtime = CodebaseRuntime::open(
        Dir::open_local(directory.path()).unwrap(),
        Arc::new(CodebaseStore::memory()),
        Some(Arc::new(GrepCandidates(Mutex::new(vec![grep_candidate()])))),
    )
    .unwrap();
    runtime.rebuild().unwrap();
    let query = CodebaseQuery::new("needle");
    assert!(runtime.index().search(&query).unwrap().is_empty());
    assert_eq!(runtime.search(&query).unwrap().len(), 1);

    fs::write(&path, "pub fn replaced() {}\n").unwrap();
    // Leave both indexes unchanged: the current file must invalidate the candidate.
    assert!(runtime.search(&query).unwrap().is_empty());
    fs::write(&path, original).unwrap();
    runtime.rebuild().unwrap();
    runtime
        .index()
        .synchronize_overlay(ash_codebase::CodebaseOverlayDocument {
            relative_path: "lib.rs".into(),
            editor_revision: 1,
            language: ash_codebase::IndexedLanguage::Rust,
            content: "pub fn unsaved_only() {}\n".into(),
        })
        .unwrap();
    assert!(runtime.search(&query).unwrap().is_empty());
    let overlay = runtime.search(&CodebaseQuery::new("unsaved_only")).unwrap();
    assert_eq!(overlay.len(), 1);
    assert_eq!(overlay[0].content, "pub fn unsaved_only() {}\n");
    runtime
        .index()
        .close_overlay(std::path::Path::new("lib.rs"))
        .unwrap();
    assert_eq!(runtime.search(&query).unwrap().len(), 1);
}

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
