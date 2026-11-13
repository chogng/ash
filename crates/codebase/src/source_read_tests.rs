use crate::Codebase;
use crate::CodebaseError;
use crate::CodebaseLimits;
use crate::CodebaseQuery;
use crate::SourceExcerptReference;
use ash_file_access::Dir;
use std::cell::RefCell;
use std::fs;
use std::path::Path;
use tempfile::TempDir;

thread_local! {
    static OPEN_HOOK: RefCell<Option<Box<dyn FnOnce()>>> = const { RefCell::new(None) };
    static RESOLUTION_HOOK: RefCell<Option<Box<dyn FnOnce()>>> = const { RefCell::new(None) };
}

pub(crate) fn after_resolution() {
    let hook = RESOLUTION_HOOK.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook();
    }
}

pub(crate) fn after_open() {
    let hook = OPEN_HOOK.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook();
    }
}

#[derive(Clone, Copy, Debug)]
enum Replacement {
    Leaf,
    Parent,
    Root,
}

struct Fixture {
    _temp: TempDir,
    root: std::path::PathBuf,
    outside: std::path::PathBuf,
    index: Codebase,
}

impl Fixture {
    fn new(outside_content: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        let outside = temp.path().join("outside");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(outside.join("src")).unwrap();
        fs::write(root.join("src/lib.rs"), "pub fn allowed_source() {}\n").unwrap();
        fs::write(outside.join("src/lib.rs"), outside_content).unwrap();
        let index =
            Codebase::open_memory(Dir::open_local(&root).unwrap(), CodebaseLimits::default())
                .unwrap();
        Self {
            _temp: temp,
            root,
            outside,
            index,
        }
    }

    fn replace_after_resolution(&self, replacement: Replacement) {
        let root = self.root.clone();
        let outside = self.outside.clone();
        RESOLUTION_HOOK.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                let (entry, target) = match replacement {
                    Replacement::Leaf => (root.join("src/lib.rs"), outside.join("src/lib.rs")),
                    Replacement::Parent => (root.join("src"), outside.join("src")),
                    Replacement::Root => (root.clone(), outside),
                };
                fs::rename(&entry, root.with_extension("saved")).unwrap();
                std::os::unix::fs::symlink(target, entry).unwrap();
            }));
        });
    }
}

fn assert_boundary_error<T>(result: Result<T, CodebaseError>) {
    assert!(matches!(
        result,
        Err(CodebaseError::Io { .. } | CodebaseError::DirPath(_))
    ));
}

fn assert_scan_rejects_replacement(replacement: Replacement) {
    let fixture = Fixture::new("pub fn outside_marker() {}\n");
    fixture.replace_after_resolution(replacement);
    let result = fixture.index.rebuild();
    assert!(
        result.is_err() || fixture.index.manifest().unwrap().sources.is_empty(),
        "scan published the replaced {replacement:?}"
    );
    assert!(
        fixture
            .index
            .search(&CodebaseQuery::new("outside_marker"))
            .unwrap()
            .is_empty(),
        "outside content entered the local projection"
    );
}

fn assert_incremental_rejects_replacement(replacement: Replacement) {
    let fixture = Fixture::new("pub fn outside_marker() {}\n");
    let initial = fixture.index.rebuild().unwrap();
    fixture.replace_after_resolution(replacement);
    assert_boundary_error(
        fixture
            .index
            .refresh_observed_paths(&[fixture.root.join("src/lib.rs")]),
    );
    assert_eq!(fixture.index.snapshot().unwrap(), initial);
    assert!(
        fixture
            .index
            .search(&CodebaseQuery::new("outside_marker"))
            .unwrap()
            .is_empty()
    );
}

#[derive(Clone, Copy, Debug)]
enum Verification {
    Chunk,
    Excerpt,
    Source,
    Chunks,
    VerifiedExcerpt,
}

fn assert_materializations_reject_replacement(replacement: Replacement) {
    for verification in [
        Verification::Chunk,
        Verification::Excerpt,
        Verification::Source,
        Verification::Chunks,
        Verification::VerifiedExcerpt,
    ] {
        // Matching bytes deliberately defeat revision/hash checks: access must be
        // rejected at open time even when the outside file happens to be identical.
        let fixture = Fixture::new("pub fn allowed_source() {}\n");
        fixture.index.rebuild().unwrap();
        let manifest = fixture.index.manifest().unwrap();
        let chunk = &manifest.chunks[0];
        let source = &manifest.sources[0];
        fixture.replace_after_resolution(replacement);
        let result = match verification {
            Verification::Chunk => fixture.index.materialize(&chunk.reference).map(|_| ()),
            Verification::Excerpt => fixture
                .index
                .materialize_excerpt(&SourceExcerptReference {
                    root_id: chunk.reference.root_id.clone(),
                    relative_path: chunk.reference.relative_path.clone(),
                    source_revision: chunk.reference.source_revision.clone(),
                    content_hash: chunk.reference.content_hash.clone(),
                    span: chunk.reference.span.clone(),
                })
                .map(|_| ()),
            Verification::Source => fixture
                .index
                .materialize_sources(std::slice::from_ref(source))
                .map(|_| ()),
            Verification::Chunks => fixture
                .index
                .materialize_chunks(std::slice::from_ref(chunk))
                .map(|_| ()),
            Verification::VerifiedExcerpt => fixture
                .index
                .materialize_verified_excerpt(source, chunk.reference.span.clone())
                .map(|_| ()),
        };
        assert!(
            result.is_err(),
            "{verification:?} followed replaced {replacement:?}"
        );
        assert_boundary_error(result);
    }
}

#[test]
fn scanner_keeps_existing_symlink_rules_and_verification_allows_internal_aliases() {
    let fixture = Fixture::new("outside_marker");
    std::os::unix::fs::symlink("src", fixture.root.join("alias")).unwrap();
    std::os::unix::fs::symlink("src/lib.rs", fixture.root.join("alias.rs")).unwrap();
    std::os::unix::fs::symlink(fixture.outside.join("src"), fixture.root.join("outside")).unwrap();
    fixture.index.rebuild().unwrap();
    let manifest = fixture.index.manifest().unwrap();
    assert_eq!(manifest.sources.len(), 1);
    assert_eq!(manifest.sources[0].relative_path, Path::new("src/lib.rs"));
    let mut reference = manifest.sources[0].clone();
    for alias in ["alias/lib.rs", "alias.rs"] {
        reference.relative_path = alias.into();
        assert_eq!(
            fixture
                .index
                .materialize_sources(&[reference.clone()])
                .unwrap()[0]
                .content,
            "pub fn allowed_source() {}\n"
        );
    }
}

#[test]
fn scan_rejects_replaced_leaf() {
    assert_scan_rejects_replacement(Replacement::Leaf);
}

#[test]
fn scan_rejects_replaced_parent() {
    assert_scan_rejects_replacement(Replacement::Parent);
}

#[test]
fn scan_rejects_replaced_root() {
    assert_scan_rejects_replacement(Replacement::Root);
}

#[test]
fn incremental_rejects_replaced_leaf() {
    assert_incremental_rejects_replacement(Replacement::Leaf);
}

#[test]
fn incremental_rejects_replaced_parent() {
    assert_incremental_rejects_replacement(Replacement::Parent);
}

#[test]
fn incremental_rejects_replaced_root() {
    assert_incremental_rejects_replacement(Replacement::Root);
}

#[test]
fn materialization_rejects_replaced_leaf() {
    assert_materializations_reject_replacement(Replacement::Leaf);
}

#[test]
fn materialization_rejects_replaced_parent() {
    assert_materializations_reject_replacement(Replacement::Parent);
}

#[test]
fn materialization_rejects_replaced_root() {
    assert_materializations_reject_replacement(Replacement::Root);
}

#[test]
fn opened_source_stays_pinned_when_its_leaf_or_parent_is_replaced() {
    for replacement in [Replacement::Leaf, Replacement::Parent] {
        let fixture = Fixture::new("pub fn outside_marker() {}\n");
        fixture.replace_after_resolution(replacement);
        // Move the exact same interleaving past the open, before metadata/read.
        let hook = RESOLUTION_HOOK.with(|slot| slot.borrow_mut().take());
        OPEN_HOOK.with(|slot| *slot.borrow_mut() = hook);
        fixture.index.rebuild().unwrap();
        let hits = fixture
            .index
            .search(&CodebaseQuery::new("allowed_source"))
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].content, "pub fn allowed_source() {}\n");
        assert!(
            fixture
                .index
                .search(&CodebaseQuery::new("outside_marker"))
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn source_open_rechecks_root_identity_before_reading() {
    let fixture = Fixture::new("outside_marker");
    fixture.replace_after_resolution(Replacement::Root);
    let hook = RESOLUTION_HOOK.with(|slot| slot.borrow_mut().take());
    OPEN_HOOK.with(|slot| *slot.borrow_mut() = hook);
    assert_boundary_error(fixture.index.rebuild());
    assert!(fixture.index.manifest().unwrap().sources.is_empty());
}

#[test]
fn empty_scan_rejects_a_replaced_root_and_the_old_binding_stays_retired() {
    let fixture = Fixture::new("outside_marker");
    let initial = fixture.index.rebuild().unwrap();
    fs::rename(&fixture.root, fixture.root.with_extension("saved")).unwrap();
    fs::create_dir(&fixture.root).unwrap();
    assert_boundary_error(fixture.index.reconcile());
    fs::remove_dir(&fixture.root).unwrap();
    fs::rename(fixture.root.with_extension("saved"), &fixture.root).unwrap();
    assert_boundary_error(fixture.index.reconcile());
    assert_eq!(fixture.index.snapshot().unwrap(), initial);
    let reopened = Codebase::open_memory(
        Dir::open_local(&fixture.root).unwrap(),
        CodebaseLimits::default(),
    )
    .unwrap();
    assert_eq!(reopened.rebuild().unwrap().indexed_file_count, 1);
}

#[test]
fn source_type_is_checked_on_the_opened_file() {
    for verification in [false, true] {
        let fixture = Fixture::new("outside_marker");
        fixture.index.rebuild().unwrap();
        let source = fixture.index.manifest().unwrap().sources[0].clone();
        let path = fixture.root.join("src/lib.rs");
        RESOLUTION_HOOK.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                fs::remove_file(&path).unwrap();
                fs::create_dir(&path).unwrap();
            }))
        });
        if verification {
            assert_boundary_error(fixture.index.materialize_sources(&[source]));
        } else {
            assert_eq!(fixture.index.rebuild().unwrap().indexed_file_count, 0);
        }
    }
}

#[test]
fn cancellation_during_source_open_keeps_the_published_generation() {
    let fixture = Fixture::new("outside_marker");
    let initial = fixture.index.rebuild().unwrap();
    fs::write(
        fixture.root.join("src/lib.rs"),
        "pub fn updated_source() {}\n",
    )
    .unwrap();
    let cancellation = ash_async_utils::CancellationSource::new();
    let stop = cancellation.clone();
    OPEN_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            stop.cancel();
        }));
    });
    assert!(matches!(
        fixture
            .index
            .reconcile_with_cancellation(&cancellation.token()),
        Err(CodebaseError::Cancelled)
    ));
    assert_eq!(fixture.index.snapshot().unwrap(), initial);
    assert_eq!(
        fixture.index.reconcile().unwrap().generation,
        initial.generation + 1
    );
    assert_eq!(
        fixture
            .index
            .search(&CodebaseQuery::new("updated_source"))
            .unwrap()
            .len(),
        1
    );
}
