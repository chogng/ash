use std::fs;
use std::num::NonZeroUsize;

use ash_file_access::Dir;
use tempfile::TempDir;

use crate::Codebase;
use crate::CodebaseError;
use crate::CodebaseLimits;
use crate::CodebaseOverlayDocument;
use crate::CodebaseQuery;
use crate::RefreshOutcome;
use crate::SourceExcerptReference;
use ash_language::LanguageId;

fn dir() -> TempDir {
    let directory = tempfile::tempdir().expect("dir");
    fs::create_dir(directory.path().join(".git")).expect("git marker");
    directory
}

fn memory_index(directory: &TempDir) -> Codebase {
    Codebase::open_memory(
        Dir::open_local(directory.path()).expect("root"),
        CodebaseLimits::default(),
    )
    .expect("index")
}

#[test]
fn source_detection_uses_package_filenames_suffixes_and_first_lines() {
    let directory = dir();
    for (path, text) in [
        ("tsconfig.json", "{\"compilerOptions\": {}}\n"),
        ("main.py", "def python_entry():\n    pass\n"),
        ("main.go", "package main\nfunc goEntry() {}\n"),
        ("script", "#!/usr/bin/env bash\necho script_entry\n"),
    ] {
        fs::write(directory.path().join(path), text).unwrap();
    }
    let index = memory_index(&directory);
    index.rebuild().unwrap();
    let manifest = index.manifest().unwrap();
    for (path, language) in [
        ("tsconfig.json", "jsonc"),
        ("main.py", "python"),
        ("main.go", "go"),
        ("script", "shellscript"),
    ] {
        let source = manifest
            .sources
            .iter()
            .find(|source| source.relative_path == std::path::Path::new(path))
            .unwrap();
        assert_eq!(source.language.as_str(), language);
        let materialized = index
            .materialize_sources(std::slice::from_ref(source))
            .unwrap();
        assert_eq!(materialized[0].reference.language.as_str(), language);
    }
    let symbols = crate::SymbolIndex::open_memory(
        std::sync::Arc::new(index),
        crate::SymbolIndexLimits::default(),
    )
    .unwrap();
    symbols.reconcile().unwrap();
    assert!(
        !symbols
            .search(&crate::SymbolIndexQuery::new("python_entry"))
            .unwrap()
            .is_empty()
    );
    assert!(
        !symbols
            .search(&crate::SymbolIndexQuery::new("goEntry"))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn overlays_preserve_language_identity_without_requiring_a_parser() {
    let directory = dir();
    let index = memory_index(&directory);
    index.rebuild().unwrap();
    index
        .synchronize_overlay(CodebaseOverlayDocument {
            relative_path: "custom.source".into(),
            editor_revision: 1,
            language: LanguageId::parse("custom.language").unwrap(),
            content: "custom_overlay_content".into(),
        })
        .unwrap();
    let hits = index
        .search(&CodebaseQuery::new("custom_overlay_content"))
        .unwrap();
    assert_eq!(hits[0].language.as_str(), "custom.language");
}

#[test]
fn reconcile_retains_generation_for_identical_sources_and_detects_changes() {
    let directory = dir();
    let source = directory.path().join("lib.rs");
    fs::write(&source, "pub fn original() {}\n").unwrap();
    let index = memory_index(&directory);
    let initial = index.reconcile().unwrap();
    assert_eq!(initial.generation, 1);
    assert_eq!(index.reconcile().unwrap(), initial);

    fs::write(directory.path().join(".git/metadata"), "ignored metadata").unwrap();
    assert_eq!(index.reconcile().unwrap(), initial);
    let hint = index
        .refresh_observed_paths(&[directory.path().to_path_buf()])
        .unwrap();
    assert_eq!(hint, RefreshOutcome::Rebuilt(initial.clone()));

    fs::write(&source, "pub fn updated() {}\n").unwrap();
    let updated = index.reconcile().unwrap();
    assert_eq!(updated.generation, initial.generation + 1);
    assert_eq!(
        index.search(&CodebaseQuery::new("updated")).unwrap().len(),
        1
    );
    fs::write(directory.path().join("added.rs"), "pub fn added() {}\n").unwrap();
    let added = index.reconcile().unwrap();
    assert_eq!(added.generation, updated.generation + 1);
    assert_eq!(added.indexed_file_count, 2);
    fs::remove_file(directory.path().join("added.rs")).unwrap();
    let removed = index.reconcile().unwrap();
    assert_eq!(removed.generation, added.generation + 1);
    assert_eq!(removed.indexed_file_count, 1);

    // Explicit rebuild remains a new publication even when source facts match.
    assert_eq!(index.rebuild().unwrap().generation, removed.generation + 1);
}

#[test]
fn reconcile_publishes_coverage_changes_without_changing_the_indexed_source() {
    let directory = dir();
    fs::write(directory.path().join("a.rs"), "fn indexed() {}\n").unwrap();
    let index = Codebase::open_memory(
        Dir::open_local(directory.path()).unwrap(),
        CodebaseLimits {
            max_files: 1,
            ..CodebaseLimits::default()
        },
    )
    .unwrap();
    let initial = index.reconcile().unwrap();
    let original_manifest = index.manifest().unwrap();
    fs::write(directory.path().join("z.rs"), "fn omitted() {}\n").unwrap();
    let limited = index.reconcile().unwrap();
    assert_eq!(limited.generation, initial.generation + 1);
    assert!(limited.file_limit_hit);
    assert_eq!(limited.skipped_file_count, 1);
    assert_eq!(index.manifest().unwrap().sources, original_manifest.sources);
    assert_eq!(index.reconcile().unwrap(), limited);
    fs::remove_file(directory.path().join("z.rs")).unwrap();
    let restored = index.reconcile().unwrap();
    assert_eq!(restored.generation, limited.generation + 1);
    assert!(!restored.file_limit_hit);
    assert_eq!(restored.skipped_file_count, 0);
}

#[test]
fn rebuild_indexes_structural_chunks_and_searches_literal_text() {
    let directory = dir();
    fs::write(
        directory.path().join("math.rs"),
        "pub fn add(left: i32, right: i32) -> i32 { left + right }\n\
         pub fn multiply(left: i32, right: i32) -> i32 { left * right }\n",
    )
    .expect("source");
    let index = memory_index(&directory);

    let snapshot = index.rebuild().expect("rebuild");
    assert_eq!(snapshot.generation, 1);
    assert_eq!(snapshot.indexed_file_count, 1);
    assert!(snapshot.indexed_chunk_count >= 1);

    let hits = index
        .search(&CodebaseQuery::new("multiply right"))
        .expect("search");
    assert_eq!(hits.len(), 1);
    assert_eq!(
        hits[0].reference.relative_path,
        std::path::Path::new("math.rs")
    );
    assert_eq!(hits[0].language, LanguageId::RUST);
    assert!(hits[0].content.contains("multiply"));
    assert_eq!(
        index
            .materialize(&hits[0].reference)
            .expect("materialize")
            .content,
        hits[0].content
    );
}

#[test]
fn materializes_revision_bound_excerpt_without_a_local_chunk_key() {
    let directory = dir();
    fs::write(
        directory.path().join("excerpt.rs"),
        "fn first() {}\nfn cloud_boundary() {}\n",
    )
    .expect("source");
    let index = memory_index(&directory);
    index.rebuild().expect("rebuild");
    let hit = index
        .search(&CodebaseQuery::new("cloud_boundary"))
        .expect("search")
        .remove(0);
    let reference = SourceExcerptReference::from(&hit.reference);

    let excerpt = index
        .materialize_excerpt(&reference)
        .expect("materialize excerpt");

    assert_eq!(excerpt.reference, reference);
    assert_eq!(excerpt.content, hit.content);
    assert_eq!(excerpt.language, LanguageId::RUST);

    let mut invalid_lines = reference;
    invalid_lines.span.start_line = invalid_lines.span.start_line.saturating_add(1);
    assert!(matches!(
        index.materialize_excerpt(&invalid_lines),
        Err(CodebaseError::ChunkSpanMismatch)
    ));
}

#[test]
fn rebuild_honors_ignore_binary_and_file_limits() {
    let directory = dir();
    fs::write(directory.path().join("visible.rs"), "fn visible() {}\n").expect("visible");
    fs::write(directory.path().join("binary.rs"), b"fn before() {}\0after").expect("binary");
    fs::write(
        directory.path().join(".env"),
        "PRIVATE_TOKEN=must_not_index\n",
    )
    .expect("hidden");
    fs::create_dir(directory.path().join("target")).expect("target");
    fs::write(
        directory.path().join("target/generated.rs"),
        "fn hidden() {}\n",
    )
    .expect("hidden");
    let limits = CodebaseLimits::default().with_max_files(NonZeroUsize::new(2).expect("non-zero"));
    let index = Codebase::open_memory(Dir::open_local(directory.path()).expect("root"), limits)
        .expect("index");

    let snapshot = index.rebuild().expect("rebuild");
    assert_eq!(snapshot.indexed_file_count, 1);
    assert_eq!(snapshot.skipped_file_count, 1);
    assert!(
        index
            .search(&CodebaseQuery::new("hidden"))
            .expect("search")
            .is_empty()
    );
    assert!(
        index
            .search(&CodebaseQuery::new("must_not_index"))
            .expect("search")
            .is_empty()
    );
}

#[test]
fn exact_file_refresh_publishes_and_stale_reference_is_rejected() {
    let directory = dir();
    let source_path = directory.path().join("main.ts");
    fs::write(&source_path, "export function before() { return 1; }\n").expect("source");
    let index = memory_index(&directory);
    index.rebuild().expect("rebuild");
    let old_hit = index
        .search(&CodebaseQuery::new("before"))
        .expect("search")
        .remove(0);

    fs::write(&source_path, "export function after() { return 2; }\n").expect("source");
    let outcome = index
        .refresh_observed_paths(std::slice::from_ref(&source_path))
        .expect("refresh");
    let RefreshOutcome::Published(snapshot) = outcome else {
        panic!("expected exact publication");
    };
    assert_eq!(snapshot.generation, 2);
    assert!(matches!(
        index.materialize(&old_hit.reference),
        Err(CodebaseError::StaleRevision { .. })
    ));
    assert!(
        index
            .search(&CodebaseQuery::new("before"))
            .expect("search")
            .is_empty()
    );
    assert_eq!(
        index
            .search(&CodebaseQuery::new("after"))
            .expect("search")
            .len(),
        1
    );
}

#[test]
fn materialization_does_not_read_past_the_configured_file_limit() {
    let directory = dir();
    let source_path = directory.path().join("bounded.txt");
    fs::write(&source_path, "bounded_marker\n").expect("source");
    let limits = CodebaseLimits::default()
        .with_max_file_bytes(NonZeroUsize::new(64).expect("non-zero"))
        .with_max_total_source_bytes(NonZeroUsize::new(128).expect("non-zero"))
        .with_target_chunk_bytes(NonZeroUsize::new(32).expect("non-zero"))
        .with_max_chunk_bytes(NonZeroUsize::new(64).expect("non-zero"));
    let index = Codebase::open_memory(Dir::open_local(directory.path()).expect("root"), limits)
        .expect("index");
    index.rebuild().expect("rebuild");
    let hit = index
        .search(&CodebaseQuery::new("bounded_marker"))
        .expect("search")
        .remove(0);

    fs::write(&source_path, vec![b'x'; 65]).expect("oversized source");

    assert!(matches!(
        index.materialize(&hit.reference),
        Err(CodebaseError::SourceVerificationLimitExceeded)
    ));
}

#[test]
fn new_files_and_ignore_rule_changes_rebuild_instead_of_bypassing_scan_policy() {
    let directory = dir();
    fs::write(directory.path().join(".gitignore"), "ignored.rs\n").expect("ignore");
    fs::write(directory.path().join("visible.rs"), "fn visible() {}\n").expect("visible");
    let index = memory_index(&directory);
    index.rebuild().expect("rebuild");

    let ignored_path = directory.path().join("ignored.rs");
    fs::write(&ignored_path, "fn must_remain_ignored() {}\n").expect("ignored source");
    assert!(matches!(
        index
            .refresh_observed_paths(std::slice::from_ref(&ignored_path))
            .expect("new-file reconcile"),
        RefreshOutcome::Rebuilt(_)
    ));
    assert!(
        index
            .search(&CodebaseQuery::new("must_remain_ignored"))
            .expect("search")
            .is_empty()
    );

    fs::write(directory.path().join(".gitignore"), "").expect("unignore");
    assert!(matches!(
        index
            .refresh_observed_paths(&[directory.path().join(".gitignore")])
            .expect("ignore reconcile"),
        RefreshOutcome::Rebuilt(_)
    ));
    assert_eq!(
        index
            .search(&CodebaseQuery::new("must_remain_ignored"))
            .expect("search")
            .len(),
        1
    );
}

#[test]
fn hard_excluded_runtime_paths_do_not_force_rebuilds() {
    let directory = dir();
    fs::write(directory.path().join("visible.rs"), "fn visible() {}\n").expect("visible");
    fs::create_dir(directory.path().join(".ash")).expect("runtime directory");
    let runtime_path = directory.path().join(".ash/runtime.json");
    fs::write(&runtime_path, "{\"changed\":true}\n").expect("runtime state");
    let index = memory_index(&directory);
    let before = index.rebuild().expect("rebuild");

    assert_eq!(
        index
            .refresh_observed_paths(std::slice::from_ref(&runtime_path))
            .expect("refresh"),
        RefreshOutcome::NoChange
    );
    assert_eq!(
        index.snapshot().expect("snapshot").generation,
        before.generation
    );
}

#[test]
fn hidden_build_outputs_do_not_rescan_sources() {
    let directory = dir();
    fs::write(directory.path().join("visible.rs"), "fn visible() {}\n").unwrap();
    let index = memory_index(&directory);
    let before = index.rebuild().unwrap();
    fs::create_dir_all(directory.path().join(".build/output")).unwrap();
    fs::write(
        directory.path().join(".build/output/generated.rs"),
        "fn generated() {}\n",
    )
    .unwrap();

    for path in [
        ".build",
        ".build/output",
        ".build/output/generated.rs",
        ".build/.gitignore",
    ] {
        assert_eq!(
            index
                .refresh_observed_paths(&[directory.path().join(path)])
                .unwrap(),
            RefreshOutcome::NoChange,
            "build artifact {path} must not rescan the project"
        );
    }
    assert_eq!(index.snapshot().unwrap(), before);
}

#[test]
fn excluded_paths_do_not_rescan_a_full_index_but_source_changes_do() {
    let directory = dir();
    fs::write(directory.path().join("a.rs"), "fn first() {}\n").unwrap();
    fs::write(directory.path().join("b.rs"), "fn second() {}\n").unwrap();
    let limits = CodebaseLimits::default().with_max_files(NonZeroUsize::new(1).unwrap());
    let index = Codebase::open_memory(Dir::open_local(directory.path()).unwrap(), limits).unwrap();
    let before = index.rebuild().unwrap();
    assert!(before.file_limit_hit);
    for path in [
        "target/generated.rs",
        "node_modules/package/index.js",
        ".build/output",
        ".git/objects/pack",
    ] {
        assert_eq!(
            index
                .refresh_observed_paths(&[directory.path().join(path)])
                .unwrap(),
            RefreshOutcome::NoChange
        );
    }
    fs::remove_file(directory.path().join("a.rs")).unwrap();
    assert!(matches!(
        index
            .refresh_observed_paths(&[directory.path().join("a.rs")])
            .unwrap(),
        RefreshOutcome::Rebuilt(_)
    ));
    assert_eq!(
        index.search(&CodebaseQuery::new("second")).unwrap().len(),
        1
    );
}

#[test]
fn git_info_exclude_still_invalidates_the_source_index() {
    let directory = dir();
    fs::write(directory.path().join("visible.rs"), "fn visible() {}\n").unwrap();
    let index = memory_index(&directory);
    index.rebuild().unwrap();
    fs::create_dir(directory.path().join(".git/info")).unwrap();
    let exclude = directory.path().join(".git/info/exclude");
    fs::write(&exclude, "visible.rs\n").unwrap();
    assert!(matches!(
        index.refresh_observed_paths(&[exclude]).unwrap(),
        RefreshOutcome::Rebuilt(_)
    ));
    assert_eq!(index.snapshot().unwrap().indexed_file_count, 0);
}

#[test]
fn explicitly_included_hidden_sources_refresh_but_build_outputs_stay_excluded() {
    let directory = dir();
    fs::write(
        directory.path().join(".gitignore"),
        "!.config/\n!.config/**\n!.build/\n!.build/**\n",
    )
    .unwrap();
    fs::create_dir(directory.path().join(".config")).unwrap();
    fs::create_dir(directory.path().join(".build")).unwrap();
    let source = directory.path().join(".config/source.rs");
    fs::write(&source, "fn before() {}\n").unwrap();
    fs::write(
        directory.path().join(".build/output.rs"),
        "fn generated() {}\n",
    )
    .unwrap();
    let index = memory_index(&directory);
    assert_eq!(index.rebuild().unwrap().indexed_file_count, 1);
    fs::write(&source, "fn after() {}\n").unwrap();
    assert!(matches!(
        index.refresh_observed_paths(&[source]).unwrap(),
        RefreshOutcome::Published(_)
    ));
    assert_eq!(index.search(&CodebaseQuery::new("after")).unwrap().len(), 1);
    assert!(
        index
            .search(&CodebaseQuery::new("generated"))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn query_is_literal_bounded_and_empty_query_is_rejected() {
    let directory = dir();
    fs::write(
        directory.path().join("quoted.txt"),
        "literal OR operator and quote\n",
    )
    .expect("source");
    let index = memory_index(&directory);
    index.rebuild().expect("rebuild");
    assert!(
        index
            .search(&CodebaseQuery::new("OR"))
            .expect("literal search")
            .len()
            == 1
    );
    assert!(matches!(
        index.search(&CodebaseQuery::new("   ")),
        Err(CodebaseError::InvalidQuery(_))
    ));
}

#[test]
fn chunk_limit_is_bounded_and_visible_in_the_snapshot() {
    let directory = dir();
    fs::write(
        directory.path().join("large.txt"),
        "first_marker_000\nsecond_marker_111\nlast_marker_222\n",
    )
    .expect("source");
    let limits = CodebaseLimits::default()
        .with_target_chunk_bytes(NonZeroUsize::new(16).expect("non-zero"))
        .with_max_chunk_bytes(NonZeroUsize::new(16).expect("non-zero"))
        .with_max_chunks_per_file(NonZeroUsize::new(1).expect("non-zero"));
    let index = Codebase::open_memory(Dir::open_local(directory.path()).expect("root"), limits)
        .expect("index");

    let snapshot = index.rebuild().expect("rebuild");
    assert_eq!(snapshot.indexed_chunk_count, 1);
    assert_eq!(snapshot.truncated_file_count, 1);
    assert!(
        index
            .search(&CodebaseQuery::new("last_marker_222"))
            .expect("search")
            .is_empty()
    );
}

#[test]
fn dirty_overlay_replaces_disk_search_and_materialization() {
    let directory = dir();
    fs::write(directory.path().join("service.rs"), "fn disk_name() {}\n").expect("source");
    let index = memory_index(&directory);
    index.rebuild().expect("rebuild");
    let disk_hit = index
        .search(&CodebaseQuery::new("disk_name"))
        .expect("disk search")
        .remove(0);

    index
        .synchronize_overlay(CodebaseOverlayDocument {
            relative_path: "service.rs".into(),
            editor_revision: 2,
            language: LanguageId::RUST,
            content: "fn unsaved_name() {}\n".into(),
        })
        .expect("overlay");

    assert!(
        index
            .search(&CodebaseQuery::new("disk_name"))
            .unwrap()
            .is_empty()
    );
    let overlay_hit = index
        .search(&CodebaseQuery::new("unsaved_name"))
        .unwrap()
        .remove(0);
    assert!(overlay_hit.content.contains("unsaved_name"));
    assert!(index.materialize(&overlay_hit.reference).is_ok());
    assert!(matches!(
        index.materialize(&disk_hit.reference),
        Err(CodebaseError::OverlaySupersedesPersistentSource)
    ));
}

#[test]
fn overlay_hands_back_to_matching_persistent_revision_after_save() {
    let directory = dir();
    let source = directory.path().join("service.rs");
    fs::write(&source, "fn before() {}\n").expect("source");
    let index = memory_index(&directory);
    index.rebuild().expect("rebuild");
    index
        .synchronize_overlay(CodebaseOverlayDocument {
            relative_path: "service.rs".into(),
            editor_revision: 2,
            language: LanguageId::RUST,
            content: "fn saved() {}\n".into(),
        })
        .expect("overlay");
    assert_eq!(index.overlay_snapshot().documents.len(), 1);

    fs::write(&source, "fn saved() {}\n").expect("save");
    index
        .refresh_observed_paths(&[source])
        .expect("disk refresh");
    index.handoff_matching_overlays().expect("handoff");

    assert!(index.overlay_snapshot().documents.is_empty());
    assert_eq!(index.search(&CodebaseQuery::new("saved")).unwrap().len(), 1);
}

#[test]
fn older_editor_revision_cannot_replace_a_newer_overlay() {
    let directory = dir();
    let index = memory_index(&directory);
    index.rebuild().expect("rebuild");
    for (revision, content) in [(3, "fn newest() {}\n"), (2, "fn stale() {}\n")] {
        let result = index.synchronize_overlay(CodebaseOverlayDocument {
            relative_path: "new.rs".into(),
            editor_revision: revision,
            language: LanguageId::RUST,
            content: content.into(),
        });
        if revision == 3 {
            assert!(result.is_ok());
        } else {
            assert!(matches!(
                result,
                Err(CodebaseError::OverlayRevisionConflict)
            ));
        }
    }
}

#[test]
fn equal_editor_revision_cannot_identify_two_different_snapshots() {
    let directory = dir();
    let index = memory_index(&directory);
    index.rebuild().expect("rebuild");
    index
        .synchronize_overlay(CodebaseOverlayDocument {
            relative_path: "new.rs".into(),
            editor_revision: 3,
            language: LanguageId::RUST,
            content: "fn first() {}\n".into(),
        })
        .expect("first snapshot");

    assert!(matches!(
        index.synchronize_overlay(CodebaseOverlayDocument {
            relative_path: "new.rs".into(),
            editor_revision: 3,
            language: LanguageId::RUST,
            content: "fn conflicting() {}\n".into(),
        }),
        Err(CodebaseError::OverlayRevisionConflict)
    ));
}

#[test]
fn cancelled_watcher_scan_keeps_the_published_generation_and_a_new_owner_can_reconcile() {
    let directory = dir();
    let file = directory.path().join("main.rs");
    fs::write(&file, "fn before() {}\n").unwrap();
    let index = memory_index(&directory);
    let before = index.rebuild().unwrap();
    fs::write(&file, "fn after() {}\n").unwrap();
    let cancelled = ash_async_utils::CancellationSource::new();
    cancelled.cancel();
    assert!(matches!(
        index.reconcile_with_cancellation(&cancelled.token()),
        Err(CodebaseError::Cancelled)
    ));
    assert!(matches!(
        index.refresh_observed_paths_with_cancellation(
            &[directory.path().to_path_buf()],
            &cancelled.token()
        ),
        Err(CodebaseError::Cancelled)
    ));
    assert_eq!(index.snapshot().unwrap(), before);
    let fresh = ash_async_utils::CancellationSource::new();
    assert!(matches!(
        index
            .refresh_observed_paths_with_cancellation(
                &[directory.path().to_path_buf()],
                &fresh.token()
            )
            .unwrap(),
        RefreshOutcome::Rebuilt(_)
    ));
    assert!(index.snapshot().unwrap().generation > before.generation);
    assert!(
        !index
            .search(&CodebaseQuery::new("after"))
            .unwrap()
            .is_empty()
    );
}
