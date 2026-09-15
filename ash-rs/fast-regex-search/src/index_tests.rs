use super::*;
use crate::dir_files::take_source_read_count;
use std::fs;
use tempfile::TempDir;

fn dir() -> TempDir {
    let directory = tempfile::tempdir().expect("dir");
    fs::create_dir(directory.path().join(".git")).expect("git marker");
    directory
}

fn search(directory: &TempDir, storage: FastRegexSearchStorage) -> FastRegexSearch {
    FastRegexSearch::open(
        Dir::open_local(directory.path()).expect("root"),
        storage,
        FastRegexSearchLimits::default(),
    )
    .expect("fast regex search")
}

fn query(pattern: &str) -> FastRegexQuery {
    FastRegexQuery {
        query: pattern.into(),
        pattern: FastRegexPattern::Regex,
        case_sensitivity: FastRegexCaseSensitivity::Sensitive,
        scope: PathBuf::new(),
        include_patterns: Vec::new(),
        exclude_patterns: Vec::new(),
        max_results: 20,
    }
}

fn base_file(storage: &TempDir, generation: u64, name: &str) -> PathBuf {
    storage
        .path()
        .join("bases")
        .join(format!("{generation:020}"))
        .join(name)
}

fn layer_file(storage: &TempDir, generation: u64, name: &str) -> PathBuf {
    storage
        .path()
        .join("layers")
        .join(format!("{generation:020}"))
        .join(name)
}

fn manifest_file(storage: &TempDir, generation: u64) -> PathBuf {
    storage
        .path()
        .join("manifests")
        .join(format!("{generation:020}.manifest"))
}

#[test]
fn sparse_candidates_are_verified_by_the_regex_engine() {
    let directory = dir();
    fs::write(
        directory.path().join("auth.rs"),
        "let authentication_value = token;\nlet authentication_value = other;\n",
    )
    .expect("source");
    fs::write(
        directory.path().join("noise.rs"),
        "authentication only\ntoken only\n",
    )
    .expect("noise");
    let index = search(&directory, FastRegexSearchStorage::Memory);
    index.rebuild().expect("rebuild");

    let result = index
        .search(&query(r"authentication_.*token"))
        .expect("search");

    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.matches[0].path, Path::new("auth.rs"));
    assert_eq!(result.matches[0].line_number, 1);
    assert_eq!(
        result.matches[0].ranges,
        [FastRegexRange {
            start_byte: 4,
            end_byte: 32
        }]
    );
}

#[test]
fn alternation_and_short_patterns_never_drop_valid_files() {
    let directory = dir();
    fs::write(directory.path().join("first.txt"), "pikachu\n").expect("first");
    fs::write(directory.path().join("second.txt"), "raichu\n").expect("second");
    fs::write(directory.path().join("short.txt"), "a\n").expect("short");
    let index = search(&directory, FastRegexSearchStorage::Memory);
    index.rebuild().expect("rebuild");

    let alternatives = index
        .search(&query(r"(pika|rai)chu"))
        .expect("alternatives");
    let short = index.search(&query("a")).expect("short");

    assert_eq!(
        alternatives
            .matches
            .iter()
            .map(|item| &item.path)
            .collect::<Vec<_>>(),
        [Path::new("first.txt"), Path::new("second.txt")]
    );
    assert_eq!(short.matches.len(), 3);
}

#[test]
fn refresh_and_overlay_keep_exact_search_current() {
    let directory = dir();
    let path = directory.path().join("current.rs");
    fs::write(&path, "before_marker\n").expect("before");
    let index = search(&directory, FastRegexSearchStorage::Memory);
    index.rebuild().expect("rebuild");
    fs::write(&path, "after_marker\n").expect("after");
    index.refresh_observed_paths(&[path]).expect("refresh");
    index
        .synchronize_overlay(PathBuf::from("current.rs"), "unsaved_marker\n".into())
        .expect("overlay");

    assert_eq!(
        index.search(&query("after_marker")).unwrap().matches.len(),
        0
    );
    assert_eq!(
        index
            .search(&query("unsaved_marker"))
            .unwrap()
            .matches
            .len(),
        1
    );
    index.close_overlay(Path::new("current.rs")).expect("close");
    assert_eq!(
        index.search(&query("after_marker")).unwrap().matches.len(),
        1
    );
}

#[test]
fn persistent_storage_writes_compact_index_files() {
    let directory = dir();
    fs::write(
        directory.path().join("source.rs"),
        "persistent_marker\nPERSISTENT_MARKER\n",
    )
    .expect("source");
    let storage = tempfile::tempdir().expect("storage");
    let storage_mode = FastRegexSearchStorage::Persistent(storage.path().to_path_buf());
    let index = search(&directory, storage_mode.clone());

    let built = index.rebuild().expect("rebuild");
    drop(index);
    let reopened = search(&directory, storage_mode);
    let mut insensitive = query("persistent_marker");
    insensitive.case_sensitivity = FastRegexCaseSensitivity::Insensitive;

    assert_eq!(reopened.snapshot(), built);
    assert_eq!(reopened.search(&insensitive).unwrap().matches.len(), 2);
    assert!(manifest_file(&storage, built.generation).is_file());
    assert!(base_file(&storage, built.generation, "format.bin").is_file());
    assert!(base_file(&storage, built.generation, "documents.bin").is_file());
    assert!(base_file(&storage, built.generation, "postings.bin").is_file());
    assert!(base_file(&storage, built.generation, "lookup.bin").is_file());
    assert!(layer_file(&storage, built.generation, "delta.bin").is_file());
    assert!(!storage.path().join("weights.bin").exists());
}

#[test]
fn replacing_the_lookup_generation_keeps_an_existing_reader_valid() {
    let directory = dir();
    fs::write(
        directory.path().join("first.rs"),
        "first_generation_marker\n",
    )
    .expect("first source");
    let storage = tempfile::tempdir().expect("storage");
    let storage_mode = FastRegexSearchStorage::Persistent(storage.path().to_path_buf());
    let initial = search(&directory, storage_mode.clone());
    let first_generation = initial.rebuild().expect("first generation");
    drop(initial);
    let existing_reader = search(&directory, storage_mode.clone());
    fs::write(
        directory.path().join("second.rs"),
        "second_generation_marker\n",
    )
    .expect("second source");
    let publisher = search(&directory, storage_mode.clone());

    let second_generation = publisher.rebuild().expect("replacement generation");

    assert!(second_generation.generation > first_generation.generation);
    assert_eq!(existing_reader.snapshot(), first_generation);
    assert_eq!(
        existing_reader
            .search(&query("first_generation_marker"))
            .unwrap()
            .matches
            .len(),
        1
    );
    assert!(
        existing_reader
            .search(&query("second_generation_marker"))
            .unwrap()
            .matches
            .is_empty()
    );
    drop(publisher);
    let replacement_reader = search(&directory, storage_mode);
    assert_eq!(replacement_reader.snapshot(), second_generation);
    assert_eq!(
        replacement_reader
            .search(&query("second_generation_marker"))
            .unwrap()
            .matches
            .len(),
        1
    );
}

#[test]
fn unchanged_reopen_reads_metadata_but_not_source_contents() {
    let directory = dir();
    fs::write(
        directory.path().join("source.rs"),
        "reopen_without_source_scan_marker\n",
    )
    .expect("source");
    let storage = tempfile::tempdir().expect("storage");
    let storage_mode = FastRegexSearchStorage::Persistent(storage.path().to_path_buf());
    let index = search(&directory, storage_mode.clone());
    let built = index.rebuild().expect("rebuild");
    drop(index);
    take_source_read_count();

    let reopened = search(&directory, storage_mode);

    assert_eq!(reopened.snapshot(), built);
    assert_eq!(take_source_read_count(), 0);
}

#[test]
fn posting_payload_corruption_is_detected_when_the_selected_span_is_read() {
    let directory = dir();
    fs::write(
        directory.path().join("source.rs"),
        "lazy_posting_corruption_marker\n",
    )
    .expect("source");
    let storage = tempfile::tempdir().expect("storage");
    let storage_mode = FastRegexSearchStorage::Persistent(storage.path().to_path_buf());
    let index = search(&directory, storage_mode.clone());
    let built = index.rebuild().expect("rebuild");
    drop(index);
    let postings_path = base_file(&storage, built.generation, "postings.bin");
    let mut postings = fs::read(&postings_path).expect("postings");
    postings[crate::storage::header_length()..].fill(0);
    fs::write(&postings_path, postings).expect("corrupt posting payload");
    let reopened = search(&directory, storage_mode);

    let result = reopened.search(&query("lazy_posting_corruption_marker"));

    assert!(
        matches!(result, Err(FastRegexError::CorruptIndex(path)) if path == storage.path().join("postings.bin"))
    );
}

#[test]
fn reopen_reconciles_added_deleted_and_newly_ignored_paths() {
    let directory = dir();
    let deleted = directory.path().join("deleted.rs");
    let ignored = directory.path().join("ignored.rs");
    fs::write(&deleted, "deleted_while_closed_marker\n").expect("deleted source");
    fs::write(&ignored, "ignored_while_closed_marker\n").expect("ignored source");
    let storage = tempfile::tempdir().expect("storage");
    let storage_mode = FastRegexSearchStorage::Persistent(storage.path().to_path_buf());
    let index = search(&directory, storage_mode.clone());
    index.rebuild().expect("rebuild");
    drop(index);
    fs::remove_file(deleted).expect("delete while closed");
    fs::write(
        directory.path().join("added.rs"),
        "added_while_closed_marker\n",
    )
    .expect("added source");
    fs::write(directory.path().join(".gitignore"), "ignored.rs\n").expect("ignore update");

    let reopened = search(&directory, storage_mode);

    assert_eq!(
        reopened
            .search(&query("added_while_closed_marker"))
            .unwrap()
            .matches
            .len(),
        1
    );
    assert!(
        reopened
            .search(&query("deleted_while_closed_marker"))
            .unwrap()
            .matches
            .is_empty()
    );
    assert!(
        reopened
            .search(&query("ignored_while_closed_marker"))
            .unwrap()
            .matches
            .is_empty()
    );
}

#[test]
fn reopening_reconciles_changed_files_into_the_delta_without_rebuilding_the_base() {
    let directory = dir();
    let source = directory.path().join("source.rs");
    fs::write(&source, "before_persisted_marker\n").expect("source");
    let storage = tempfile::tempdir().expect("storage");
    let storage_mode = FastRegexSearchStorage::Persistent(storage.path().to_path_buf());
    let index = search(&directory, storage_mode.clone());
    let built = index.rebuild().expect("rebuild");
    let lookup_path = base_file(&storage, built.generation, "lookup.bin");
    let lookup_before = fs::read(&lookup_path).expect("base lookup");
    drop(index);
    fs::write(&source, "after_persisted_marker\n").expect("changed source");

    let reopened = search(&directory, storage_mode);

    assert!(reopened.snapshot().generation > built.generation);
    assert_eq!(
        reopened
            .search(&query("after_persisted_marker"))
            .unwrap()
            .matches
            .len(),
        1
    );
    assert!(
        reopened
            .search(&query("before_persisted_marker"))
            .unwrap()
            .matches
            .is_empty()
    );
    assert_eq!(
        fs::read(lookup_path).expect("unchanged base lookup"),
        lookup_before
    );
}

#[test]
fn persisted_change_layer_restores_updates_and_deletions_without_rewriting_the_base() {
    let directory = dir();
    let changed = directory.path().join("changed.rs");
    let deleted = directory.path().join("deleted.rs");
    let later_deleted = directory.path().join("later-deleted.rs");
    fs::write(&changed, "before_layer_marker\n").expect("changed source");
    fs::write(&deleted, "removed_first_marker\n").expect("deleted source");
    fs::write(&later_deleted, "removed_later_marker\n").expect("later deleted source");
    let storage = tempfile::tempdir().expect("storage");
    let storage_mode = FastRegexSearchStorage::Persistent(storage.path().to_path_buf());
    let index = search(&directory, storage_mode.clone());
    let built = index.rebuild().expect("rebuild");
    let lookup_path = base_file(&storage, built.generation, "lookup.bin");
    let base_lookup_size = fs::metadata(&lookup_path).expect("lookup metadata").len();
    fs::write(&changed, "after_layer_marker\n").expect("changed source update");
    fs::remove_file(&deleted).expect("delete source");

    let outcome = index
        .refresh_observed_paths(&[changed.clone(), deleted])
        .expect("layer update");
    let published = match outcome {
        FastRegexUpdateOutcome::Published(snapshot) => snapshot,
        other => panic!("expected published update, got {other:?}"),
    };
    assert_eq!(
        fs::metadata(&lookup_path)
            .expect("lookup metadata after update")
            .len(),
        base_lookup_size
    );
    assert!(
        fs::metadata(layer_file(&storage, published.generation, "delta.bin"))
            .expect("delta metadata")
            .len()
            < base_lookup_size
    );
    drop(index);

    let reopened = search(&directory, storage_mode.clone());

    assert_eq!(reopened.snapshot(), published);
    assert_eq!(
        reopened
            .search(&query("after_layer_marker"))
            .unwrap()
            .matches
            .len(),
        1
    );
    assert_eq!(
        reopened
            .search(&query("before_layer_marker"))
            .unwrap()
            .matches
            .len(),
        0
    );
    assert_eq!(
        reopened
            .search(&query("removed_first_marker"))
            .unwrap()
            .matches
            .len(),
        0
    );
    fs::write(&changed, "final_layer_marker\n").expect("second update");
    fs::remove_file(&later_deleted).expect("later deletion");
    let second = reopened
        .refresh_observed_paths(&[changed, later_deleted])
        .expect("second layer update");
    let second_snapshot = match second {
        FastRegexUpdateOutcome::Published(snapshot) => snapshot,
        other => panic!("expected second published update, got {other:?}"),
    };
    drop(reopened);

    let reopened_again = search(&directory, storage_mode);

    assert_eq!(reopened_again.snapshot(), second_snapshot);
    assert_eq!(
        reopened_again
            .search(&query("final_layer_marker"))
            .unwrap()
            .matches
            .len(),
        1
    );
    assert_eq!(
        reopened_again
            .search(&query("removed_later_marker"))
            .unwrap()
            .matches
            .len(),
        0
    );
}

#[test]
fn a_large_change_layer_is_compacted_into_a_new_base_generation() {
    let directory = dir();
    let paths = (0..DELTA_COMPACTION_MIN_PATHS)
        .map(|index| {
            let path = directory.path().join(format!("source-{index}.rs"));
            fs::write(&path, format!("before_compaction_{index}\n")).expect("source");
            path
        })
        .collect::<Vec<_>>();
    let storage = tempfile::tempdir().expect("storage");
    let storage_mode = FastRegexSearchStorage::Persistent(storage.path().to_path_buf());
    let index = search(&directory, storage_mode.clone());
    let first = index.rebuild().expect("first generation");
    for (file_index, path) in paths.iter().enumerate() {
        fs::write(path, format!("after_compaction_{file_index}\n")).expect("changed source");
    }

    let outcome = index
        .refresh_observed_paths(&paths)
        .expect("compact change layer");
    let compacted = match outcome {
        FastRegexUpdateOutcome::Rebuilt(snapshot) => snapshot,
        other => panic!("expected rebuilt generation, got {other:?}"),
    };
    assert!(compacted.generation > first.generation);
    drop(index);

    let reopened = search(&directory, storage_mode);

    assert_eq!(reopened.snapshot(), compacted);
    assert_eq!(
        reopened
            .search(&query("after_compaction_127"))
            .unwrap()
            .matches
            .len(),
        1
    );
}

#[test]
fn corrupt_completed_generation_is_rejected_instead_of_serving_partial_postings() {
    let directory = dir();
    fs::write(directory.path().join("source.rs"), "corrupt_marker\n").expect("source");
    let storage = tempfile::tempdir().expect("storage");
    let storage_mode = FastRegexSearchStorage::Persistent(storage.path().to_path_buf());
    let index = search(&directory, storage_mode.clone());
    let built = index.rebuild().expect("rebuild");
    drop(index);
    fs::write(
        base_file(&storage, built.generation, "lookup.bin"),
        b"truncated",
    )
    .expect("corrupt lookup");

    let result = FastRegexSearch::open(
        Dir::open_local(directory.path()).expect("root"),
        storage_mode,
        FastRegexSearchLimits::default(),
    );

    assert!(matches!(result, Err(FastRegexError::CorruptIndex(_))));
}

#[test]
fn persisted_paths_that_escape_the_dir_are_rejected() {
    let directory = dir();
    fs::write(directory.path().join("inside.rs"), "safe_path_marker\n").expect("source");
    let storage = tempfile::tempdir().expect("storage");
    let storage_mode = FastRegexSearchStorage::Persistent(storage.path().to_path_buf());
    let index = search(&directory, storage_mode.clone());
    let built = index.rebuild().expect("rebuild");
    drop(index);
    let documents_path = base_file(&storage, built.generation, "documents.bin");
    let mut documents = fs::read(&documents_path).expect("documents");
    let path_offset = crate::storage::header_length() + 8 + 8 + 4;
    let escaping_path = crate::path_codec::encode(Path::new("../bad.rs"));
    documents[path_offset..path_offset + escaping_path.len()].copy_from_slice(&escaping_path);
    fs::write(documents_path, documents).expect("corrupt stored path");

    let result = FastRegexSearch::open(
        Dir::open_local(directory.path()).expect("root"),
        storage_mode,
        FastRegexSearchLimits::default(),
    );

    match result {
        Err(FastRegexError::CorruptIndex(_)) => {}
        Err(error) => panic!("unexpected error for an escaping stored path: {error:?}"),
        Ok(_) => panic!("an escaping stored path opened successfully"),
    }
}

#[test]
fn delta_generation_must_match_the_published_manifest() {
    let directory = dir();
    let source = directory.path().join("source.rs");
    fs::write(&source, "first_delta_generation_marker\n").expect("source");
    let storage = tempfile::tempdir().expect("storage");
    let storage_mode = FastRegexSearchStorage::Persistent(storage.path().to_path_buf());
    let index = search(&directory, storage_mode.clone());
    index.rebuild().expect("rebuild");
    fs::write(&source, "second_delta_generation_marker\n").expect("changed source");
    let published = index
        .refresh_observed_paths(&[source])
        .expect("publish delta");
    let FastRegexUpdateOutcome::Published(snapshot) = published else {
        panic!("expected a delta publication");
    };
    drop(index);
    let delta_path = layer_file(&storage, snapshot.generation, "delta.bin");
    let mut delta = fs::read(&delta_path).expect("delta");
    let generation_offset = crate::storage::STORE_VERSION.len() + 32 + 8;
    delta[generation_offset..generation_offset + 8]
        .copy_from_slice(&(snapshot.generation + 1).to_le_bytes());
    fs::write(delta_path, delta).expect("corrupt delta generation");

    let result = FastRegexSearch::open(
        Dir::open_local(directory.path()).expect("root"),
        storage_mode,
        FastRegexSearchLimits::default(),
    );

    assert!(matches!(result, Err(FastRegexError::CorruptIndex(_))));
}

#[test]
fn failed_base_publish_preserves_the_previous_generation() {
    let directory = dir();
    let source = directory.path().join("source.rs");
    fs::write(&source, "first_publish_marker\n").expect("source");
    let storage = tempfile::tempdir().expect("storage");
    let storage_mode = FastRegexSearchStorage::Persistent(storage.path().to_path_buf());
    let index = search(&directory, storage_mode.clone());
    let first = index.rebuild().expect("first rebuild");
    let layers = storage.path().join("layers");
    let saved_layers = storage.path().join("layers.saved");
    fs::rename(&layers, &saved_layers).expect("move layers directory");
    fs::write(&layers, b"block layer publication").expect("block layer publication");
    fs::write(&source, "second_publish_marker\n").expect("changed source");

    let result = index.rebuild();

    assert!(matches!(result, Err(FastRegexError::Io { .. })));
    assert!(manifest_file(&storage, first.generation).is_file());
    assert!(!manifest_file(&storage, first.generation + 1).exists());
    fs::remove_file(&layers).expect("remove blocker");
    fs::rename(saved_layers, layers).expect("restore layers directory");
    let reopened = search(&directory, storage_mode);
    assert!(reopened.snapshot().generation > first.generation);
    assert_eq!(
        reopened
            .search(&query("second_publish_marker"))
            .unwrap()
            .matches
            .len(),
        1
    );
}

#[test]
fn frequency_table_digest_mismatch_makes_a_generation_ineligible() {
    let directory = dir();
    fs::write(
        directory.path().join("source.rs"),
        "frequency_digest_marker\n",
    )
    .expect("source");
    let storage = tempfile::tempdir().expect("storage");
    let storage_mode = FastRegexSearchStorage::Persistent(storage.path().to_path_buf());
    let index = search(&directory, storage_mode.clone());
    let built = index.rebuild().expect("rebuild");
    drop(index);
    let format_path = base_file(&storage, built.generation, "format.bin");
    let mut format = fs::read(&format_path).expect("format marker");
    format[crate::storage::STORE_VERSION.len()] ^= 0xff;
    fs::write(format_path, format).expect("change frequency table digest");

    let reopened = search(&directory, storage_mode);

    assert!(reopened.snapshot().generation > built.generation);
    assert_eq!(
        reopened
            .search(&query("frequency_digest_marker"))
            .unwrap()
            .matches
            .len(),
        1
    );
}

#[test]
fn scope_and_filename_glob_are_applied_independently() {
    let directory = dir();
    fs::create_dir_all(directory.path().join("src/nested")).expect("source directories");
    fs::write(directory.path().join("src/root.rs"), "scoped_marker\n").expect("root source");
    fs::write(
        directory.path().join("src/nested/child.rs"),
        "scoped_marker\n",
    )
    .expect("nested source");
    fs::write(
        directory.path().join("src/nested/child.txt"),
        "scoped_marker\n",
    )
    .expect("non-matching extension");
    fs::write(directory.path().join("outside.rs"), "scoped_marker\n").expect("outside source");
    let index = search(&directory, FastRegexSearchStorage::Memory);
    index.rebuild().expect("rebuild");
    let mut scoped = query("scoped_marker");
    scoped.scope = PathBuf::from("src");
    scoped.include_patterns = vec!["*.rs".into()];

    let result = index.search(&scoped).expect("scoped search");

    assert_eq!(
        result
            .matches
            .iter()
            .map(|found| found.path.as_path())
            .collect::<Vec<_>>(),
        [Path::new("src/nested/child.rs"), Path::new("src/root.rs")]
    );
}

#[test]
fn prefix_and_suffix_postings_are_intersected_before_source_scans() {
    let directory = dir();
    for index in 0..100 {
        fs::write(
            directory.path().join(format!("prefix-{index}.txt")),
            "authentication_noise_only\n",
        )
        .expect("prefix noise");
        fs::write(
            directory.path().join(format!("suffix-{index}.txt")),
            "unrelated_token\n",
        )
        .expect("suffix noise");
    }
    fs::write(
        directory.path().join("match.txt"),
        "authentication_value_token\n",
    )
    .expect("match");
    let index = search(&directory, FastRegexSearchStorage::Memory);
    index.rebuild().expect("rebuild");

    let result = index
        .search(&query(r"authentication_.*token"))
        .expect("search");

    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.statistics.indexed_file_count, 201);
    assert_eq!(result.statistics.candidate_file_count, 1);
    assert_eq!(result.statistics.scanned_file_count, 1);
}

#[test]
fn case_modes_match_ripgrep_style_smart_case() {
    let directory = dir();
    fs::write(
        directory.path().join("cases.txt"),
        "lower_marker\nLOWER_MARKER\nMixed_Marker\n",
    )
    .expect("cases");
    let index = search(&directory, FastRegexSearchStorage::Memory);
    index.rebuild().expect("rebuild");

    let mut sensitive = query("lower_marker");
    sensitive.case_sensitivity = FastRegexCaseSensitivity::Sensitive;
    let mut insensitive = sensitive.clone();
    insensitive.case_sensitivity = FastRegexCaseSensitivity::Insensitive;
    let mut smart_lower = sensitive.clone();
    smart_lower.case_sensitivity = FastRegexCaseSensitivity::Smart;
    let mut smart_upper = query("LOWER_MARKER");
    smart_upper.case_sensitivity = FastRegexCaseSensitivity::Smart;

    assert_eq!(index.search(&sensitive).unwrap().matches.len(), 1);
    assert_eq!(index.search(&insensitive).unwrap().matches.len(), 2);
    assert_eq!(index.search(&smart_lower).unwrap().matches.len(), 2);
    assert_eq!(index.search(&smart_upper).unwrap().matches.len(), 1);
}

#[test]
fn literal_patterns_escape_regex_metacharacters() {
    let directory = dir();
    fs::write(
        directory.path().join("literal.txt"),
        "call(foo)\ncallXfooY\n",
    )
    .expect("literal");
    let index = search(&directory, FastRegexSearchStorage::Memory);
    index.rebuild().expect("rebuild");
    let mut literal = query("call(foo)");
    literal.pattern = FastRegexPattern::Literal;

    let result = index.search(&literal).expect("literal search");

    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.matches[0].preview, "call(foo)");
}

#[test]
fn line_results_keep_all_ranges_and_preserve_searchable_carriage_returns() {
    let directory = dir();
    fs::write(
        directory.path().join("lines.txt"),
        "hit hit\r\nmiss\r\nhit\r\n",
    )
    .expect("lines");
    let index = search(&directory, FastRegexSearchStorage::Memory);
    index.rebuild().expect("rebuild");

    let result = index.search(&query("hit")).expect("search");

    assert_eq!(
        result.matches,
        [
            FastRegexMatch {
                path: PathBuf::from("lines.txt"),
                line_number: 1,
                preview: "hit hit\r".into(),
                ranges: vec![
                    FastRegexRange {
                        start_byte: 0,
                        end_byte: 3,
                    },
                    FastRegexRange {
                        start_byte: 4,
                        end_byte: 7,
                    },
                ],
            },
            FastRegexMatch {
                path: PathBuf::from("lines.txt"),
                line_number: 3,
                preview: "hit\r".into(),
                ranges: vec![FastRegexRange {
                    start_byte: 0,
                    end_byte: 3,
                }],
            },
        ]
    );
}

#[test]
fn line_terminators_match_ripgrep_without_a_phantom_trailing_line() {
    let directory = dir();
    fs::write(directory.path().join("lf.txt"), "value\n").expect("lf source");
    fs::write(directory.path().join("crlf.txt"), "value\r\n").expect("crlf source");
    let index = search(&directory, FastRegexSearchStorage::Memory);
    index.rebuild().expect("rebuild");

    let empty_line = index.search(&query(r"^$")).expect("empty line search");
    let carriage_return = index
        .search(&query(r"\r$"))
        .expect("carriage return search");

    assert!(empty_line.matches.is_empty());
    assert_eq!(carriage_return.matches.len(), 1);
    assert_eq!(carriage_return.matches[0].path, Path::new("crlf.txt"));
    assert_eq!(
        carriage_return.matches[0].ranges,
        [FastRegexRange {
            start_byte: 5,
            end_byte: 6,
        }]
    );
}

#[test]
fn result_limit_reports_only_when_an_additional_matching_line_exists() {
    let directory = dir();
    fs::write(
        directory.path().join("many.txt"),
        "marker\nmarker\nmarker\n",
    )
    .expect("many");
    let index = search(&directory, FastRegexSearchStorage::Memory);
    index.rebuild().expect("rebuild");
    let mut limited = query("marker");
    limited.max_results = 2;

    let result = index.search(&limited).expect("limited search");

    assert_eq!(result.matches.len(), 2);
    assert!(result.limit_hit);
}

#[test]
fn dir_scan_matches_default_hidden_and_gitignore_boundaries() {
    let directory = dir();
    fs::write(directory.path().join(".gitignore"), "ignored.txt\n").expect("ignore file");
    fs::write(directory.path().join("visible.txt"), "boundary_marker\n").expect("visible");
    fs::write(directory.path().join("ignored.txt"), "boundary_marker\n").expect("ignored");
    fs::write(directory.path().join(".hidden.txt"), "boundary_marker\n").expect("hidden");
    let index = search(&directory, FastRegexSearchStorage::Memory);

    let snapshot = index.rebuild().expect("rebuild");
    let result = index.search(&query("boundary_marker")).expect("search");

    assert_eq!(snapshot.indexed_file_count, 1);
    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.matches[0].path, Path::new("visible.txt"));
}

#[test]
fn incremental_refresh_adds_and_removes_files_without_rebuilding() {
    let directory = dir();
    fs::write(directory.path().join("base.txt"), "base_marker\n").expect("base");
    let index = search(&directory, FastRegexSearchStorage::Memory);
    index.rebuild().expect("rebuild");
    let added = directory.path().join("added.txt");
    fs::write(&added, "added_marker\n").expect("added");

    let added_outcome = index
        .refresh_observed_paths(std::slice::from_ref(&added))
        .expect("add");
    assert!(matches!(
        added_outcome,
        FastRegexUpdateOutcome::Published(_)
    ));
    assert_eq!(
        index.search(&query("added_marker")).unwrap().matches.len(),
        1
    );

    fs::remove_file(&added).expect("remove");
    let removed_outcome = index
        .refresh_observed_paths(&[added])
        .expect("remove refresh");
    assert!(matches!(
        removed_outcome,
        FastRegexUpdateOutcome::Published(_)
    ));
    assert_eq!(
        index.search(&query("added_marker")).unwrap().matches.len(),
        0
    );
}

#[test]
fn incremental_refresh_does_not_publish_gitignored_new_files() {
    let directory = dir();
    fs::write(directory.path().join(".gitignore"), "ignored-new.txt\n").expect("ignore file");
    fs::write(directory.path().join("base.txt"), "base_marker\n").expect("base");
    let index = search(&directory, FastRegexSearchStorage::Memory);
    index.rebuild().expect("rebuild");
    let ignored = directory.path().join("ignored-new.txt");
    fs::write(&ignored, "ignored_new_marker\n").expect("ignored source");

    let outcome = index.refresh_observed_paths(&[ignored]).expect("refresh");

    assert_eq!(outcome, FastRegexUpdateOutcome::NoChange);
    assert_eq!(
        index
            .search(&query("ignored_new_marker"))
            .unwrap()
            .matches
            .len(),
        0
    );
}

#[test]
fn changing_git_info_exclude_reconciles_the_ignore_matcher_and_index() {
    let directory = dir();
    fs::create_dir_all(directory.path().join(".git/info")).expect("git info directory");
    let exclude = directory.path().join(".git/info/exclude");
    fs::write(&exclude, "excluded-by-info.txt\n").expect("git exclude");
    fs::write(
        directory.path().join("excluded-by-info.txt"),
        "git_info_marker\n",
    )
    .expect("excluded source");
    let index = search(&directory, FastRegexSearchStorage::Memory);
    index.rebuild().expect("initial rebuild");
    assert!(
        index
            .search(&query("git_info_marker"))
            .unwrap()
            .matches
            .is_empty()
    );

    fs::write(&exclude, "").expect("clear git exclude");
    let outcome = index
        .refresh_observed_paths(&[exclude])
        .expect("refresh ignore control");

    assert!(matches!(outcome, FastRegexUpdateOutcome::Published(_)));
    assert_eq!(
        index
            .search(&query("git_info_marker"))
            .unwrap()
            .matches
            .len(),
        1
    );
}

#[test]
fn nested_ignore_change_publishes_only_the_affected_file_delta() {
    let directory = dir();
    fs::create_dir_all(directory.path().join("nested")).unwrap();
    let source = directory.path().join("nested/source.rs");
    fs::write(&source, "nested_ignore_marker\n").unwrap();
    let index = search(&directory, FastRegexSearchStorage::Memory);
    let before = index.rebuild().unwrap();

    let ignore = directory.path().join("nested/.ignore");
    fs::write(&ignore, "source.rs\n").unwrap();
    let outcome = index.refresh_observed_paths(&[ignore]).unwrap();

    let FastRegexUpdateOutcome::Published(after) = outcome else {
        panic!("ignore reconciliation should publish a delta");
    };
    assert_eq!(after.generation, before.generation + 1);
    assert!(
        index
            .search(&query("nested_ignore_marker"))
            .unwrap()
            .matches
            .is_empty()
    );
}

#[test]
fn full_reconciliation_does_not_publish_when_the_file_set_is_unchanged() {
    let directory = dir();
    fs::write(directory.path().join("source.rs"), "stable_marker\n").unwrap();
    let index = search(&directory, FastRegexSearchStorage::Memory);
    let before = index.rebuild().unwrap();

    let outcome = index.reconcile_dir().unwrap();

    assert_eq!(outcome, FastRegexUpdateOutcome::NoChange);
    assert_eq!(index.snapshot().generation, before.generation);
}

#[test]
fn stale_candidate_source_is_rejected_until_the_watcher_refreshes_it() {
    let directory = dir();
    let source = directory.path().join("source.txt");
    fs::write(&source, "old_stale_marker\n").expect("old source");
    let index = search(&directory, FastRegexSearchStorage::Memory);
    index.rebuild().expect("rebuild");
    fs::write(&source, "new_stale_marker\n").expect("new source");

    let error = index.search(&query("old_stale_marker")).unwrap_err();

    assert!(matches!(error, FastRegexError::StaleSource(path) if path == Path::new("source.txt")));
}

#[test]
fn invalid_queries_and_storage_limits_fail_at_the_public_boundary() {
    let directory = dir();
    let root = Dir::open_local(directory.path()).expect("root");
    let invalid_limits = FastRegexSearchLimits {
        max_files: 0,
        ..FastRegexSearchLimits::default()
    };
    assert!(matches!(
        FastRegexSearch::open(root, FastRegexSearchStorage::Memory, invalid_limits),
        Err(FastRegexError::InvalidLimits)
    ));

    let index = search(&directory, FastRegexSearchStorage::Memory);
    fs::write(directory.path().join("source.txt"), "text\n").expect("source");
    index.rebuild().expect("rebuild");
    let mut invalid_scope = query("text");
    invalid_scope.scope = PathBuf::from("../outside");
    assert!(matches!(
        index.search(&invalid_scope),
        Err(FastRegexError::InvalidQuery("search scope is invalid"))
    ));
    let mut invalid_glob = query("text");
    invalid_glob.include_patterns = vec!["[".into()];
    assert!(matches!(
        index.search(&invalid_glob),
        Err(FastRegexError::InvalidGlob)
    ));
    assert!(matches!(
        index.search(&query("(")),
        Err(FastRegexError::Regex(_))
    ));
}

#[test]
fn unsupported_text_files_are_skipped_without_aborting_the_generation() {
    let directory = dir();
    fs::write(directory.path().join("valid.txt"), "valid_marker\n").expect("valid");
    fs::write(directory.path().join("binary.bin"), b"binary\0marker").expect("binary");
    fs::write(directory.path().join("invalid.txt"), [0xff, 0xfe, 0xfd]).expect("invalid utf8");
    let index = search(&directory, FastRegexSearchStorage::Memory);

    let snapshot = index.rebuild().expect("rebuild");

    assert_eq!(snapshot.indexed_file_count, 1);
    assert_eq!(
        index.search(&query("valid_marker")).unwrap().matches.len(),
        1
    );
}

#[test]
fn indexed_candidates_match_an_exhaustive_scan_across_regex_shapes() {
    let directory = dir();
    let documents = [
        (
            "one.rs",
            "fn alpha_rare_handler() {}\nauthentication_value_token\nfoo_bar\n",
        ),
        (
            "two.rs",
            "fn beta_rare_handler() {}\nauthentication noise\ntoken only\nfoo_baz\n",
        ),
        (
            "three.rs",
            "fn gamma_handler() {}\nAUTHENTICATION_VALUE_TOKEN\nnumber 123\n",
        ),
        ("unicode.rs", "fn 解析器() {}\n认证_值_令牌\n"),
    ];
    for (path, content) in documents {
        fs::write(directory.path().join(path), content).expect("corpus source");
    }
    let index = search(&directory, FastRegexSearchStorage::Memory);
    index.rebuild().expect("rebuild");
    let cases = [
        (r"authentication_.*token", false),
        (r"(?:alpha|beta)_rare_handler", false),
        (r"(?:authentication|a).*token", false),
        (r"foo_(?:bar|baz)", false),
        (r"^fn\s+", false),
        (r"[0-9]{3}", false),
        (r"认证_.*令牌", false),
        (r"authentication_.*token", true),
        (r"missing_dir_marker_.*suffix", false),
    ];

    for (pattern, insensitive) in cases {
        let mut indexed_query = query(pattern);
        if insensitive {
            indexed_query.case_sensitivity = FastRegexCaseSensitivity::Insensitive;
        }
        let actual = index.search(&indexed_query).expect("indexed search");
        let matcher = RegexBuilder::new(pattern)
            .case_insensitive(insensitive)
            .build()
            .expect("exhaustive matcher");
        let mut expected = Vec::new();
        let mut limit_hit = false;
        for (path, content) in documents {
            collect_matches(
                Path::new(path),
                content,
                &matcher,
                indexed_query.max_results,
                &mut expected,
                &mut limit_hit,
            );
        }
        expected.sort_by(|left, right| {
            (&left.path, left.line_number).cmp(&(&right.path, right.line_number))
        });

        assert_eq!(actual.matches, expected, "pattern {pattern}");
        assert!(!limit_hit);
    }
}

#[test]
fn internal_literals_and_nested_branches_narrow_candidates() {
    let directory = dir();
    let documents = [
        ("alpha.txt", "xx alpha_rare_handler yy\n"),
        ("beta.txt", "xx beta_rare_handler yy\n"),
        ("noise.txt", "xx unrelated yy\n"),
        ("short.txt", "x aaa\n"),
    ];
    for (path, content) in documents {
        fs::write(directory.path().join(path), content).unwrap();
    }
    let storage = tempfile::tempdir().unwrap();
    let index = search(
        &directory,
        FastRegexSearchStorage::Persistent(storage.path().into()),
    );
    index.rebuild().unwrap();
    for (pattern, candidates, matches) in [
        (r".*alpha_rare_handler.*", 1, 1),
        (r".*(?:alpha_rare_handler|beta_rare_handler).*", 2, 2),
        (r".*(?:alpha|beta)_rare_handler.*", 2, 2),
        (r"(?:alpha_rare_handler|beta_rare_handler)+", 2, 2),
        (r"alpha_rare_handler|x", 4, 4),
        (r"(?:alpha_rare_handler)?x", 4, 4),
        (r"a{3}", 1, 1),
    ] {
        let result = index.search(&query(pattern)).unwrap();
        assert_eq!(
            result.statistics.candidate_file_count, candidates,
            "{pattern}"
        );
        assert_eq!(result.matches.len(), matches, "{pattern}");
    }
}

#[test]
fn unicode_case_equivalents_are_retained_in_separate_files_and_overlays() {
    let directory = dir();
    let documents = [
        ("kelvin.txt", "Kelvin\n"),
        ("long-s.txt", "ſignal\n"),
        ("accent.txt", "ÉCOLE\n"),
        ("ascii.txt", "Kelvin\nsignal\n"),
        ("noise.txt", "unrelated\n"),
    ];
    for (path, content) in documents {
        fs::write(directory.path().join(path), content).unwrap();
    }
    let storage = tempfile::tempdir().unwrap();
    let mode = FastRegexSearchStorage::Persistent(storage.path().into());
    let built = search(&directory, mode.clone());
    built.rebuild().unwrap();
    drop(built);
    let index = search(&directory, mode);
    for (pattern, insensitive) in [
        ("kelvin", true),
        ("signal", true),
        ("école", true),
        ("(?i)kelvin", false),
        (r".*(?i:signal).*", false),
        ("(?i:kel)(?-i:vin)", false),
        ("(?-i:kelvin)", true),
        ("ÉCOLE", false),
        (r"(?-u:[Kk])elvin", false),
    ] {
        let mut q = query(pattern);
        if insensitive {
            q.case_sensitivity = FastRegexCaseSensitivity::Insensitive;
        }
        let matcher = RegexBuilder::new(pattern)
            .case_insensitive(insensitive)
            .build()
            .unwrap();
        let expected = documents
            .iter()
            .flat_map(|(path, content)| {
                content
                    .lines()
                    .enumerate()
                    .filter_map(|(line, text)| {
                        matcher
                            .is_match(text)
                            .then(|| (PathBuf::from(path), line + 1, text.to_string()))
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<BTreeSet<_>>();
        let actual = index
            .search(&q)
            .unwrap()
            .matches
            .into_iter()
            .map(|found| (found.path, found.line_number, found.preview))
            .collect::<BTreeSet<_>>();
        assert_eq!(actual, expected, "{pattern}, insensitive={insensitive}");
    }
    index
        .synchronize_overlay(PathBuf::from("noise.txt"), "KELVIN\n".into())
        .unwrap();
    let mut literal = query("kelvin");
    literal.pattern = FastRegexPattern::Literal;
    literal.case_sensitivity = FastRegexCaseSensitivity::Insensitive;
    assert_eq!(index.search(&literal).unwrap().matches.len(), 3);
}

#[test]
fn file_capacity_failure_does_not_publish_a_partial_corpus() {
    let directory = dir();
    fs::write(directory.path().join("a.txt"), "alpha\n").unwrap();
    fs::write(directory.path().join("z.txt"), "target_marker\n").unwrap();
    let index = FastRegexSearch::open(
        Dir::open_local(directory.path()).unwrap(),
        FastRegexSearchStorage::Memory,
        FastRegexSearchLimits {
            max_files: 1,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(matches!(
        index.rebuild(),
        Err(FastRegexError::IndexLimitExceeded("max_files"))
    ));
    assert_eq!(index.snapshot().generation, 0);
    assert!(matches!(
        index.search(&query("target_marker")),
        Err(FastRegexError::NotReady)
    ));
}

#[test]
fn source_capacity_is_checked_during_build_and_incremental_growth() {
    let directory = dir();
    let first = directory.path().join("a.txt");
    let second = directory.path().join("b.txt");
    fs::write(&first, "alpha").unwrap();
    fs::write(&second, "beta").unwrap();
    let limits = FastRegexSearchLimits {
        max_file_bytes: 10,
        max_total_source_bytes: 10,
        ..Default::default()
    };
    let index = FastRegexSearch::open(
        Dir::open_local(directory.path()).unwrap(),
        FastRegexSearchStorage::Memory,
        limits,
    )
    .unwrap();
    let initial = index.rebuild().unwrap();
    fs::write(&first, "alpha12345").unwrap();
    assert!(matches!(
        index.refresh_observed_paths(&[first]),
        Err(FastRegexError::IndexLimitExceeded("max_total_source_bytes"))
    ));
    assert_eq!(index.snapshot(), initial);
    assert!(matches!(
        index.reconcile_dir(),
        Err(FastRegexError::IndexLimitExceeded("max_total_source_bytes"))
    ));
    assert!(matches!(
        index.rebuild(),
        Err(FastRegexError::IndexLimitExceeded("max_total_source_bytes"))
    ));
    assert_eq!(index.snapshot(), initial);
}

#[test]
fn binary_files_do_not_consume_text_file_capacity() {
    let directory = dir();
    fs::write(directory.path().join("a.bin"), b"binary\0").unwrap();
    fs::write(directory.path().join("z.txt"), "target_marker\n").unwrap();
    let index = FastRegexSearch::open(
        Dir::open_local(directory.path()).unwrap(),
        FastRegexSearchStorage::Memory,
        FastRegexSearchLimits {
            max_files: 1,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(index.rebuild().unwrap().indexed_file_count, 1);
    assert_eq!(
        index.search(&query("target_marker")).unwrap().matches.len(),
        1
    );
}

#[test]
fn reopening_with_a_lower_capacity_rejects_the_existing_corpus() {
    let directory = dir();
    fs::write(directory.path().join("a.txt"), "alpha").unwrap();
    fs::write(directory.path().join("b.txt"), "beta").unwrap();
    let storage = tempfile::tempdir().unwrap();
    let mode = FastRegexSearchStorage::Persistent(storage.path().into());
    let index = search(&directory, mode.clone());
    index.rebuild().unwrap();
    drop(index);
    assert!(matches!(
        FastRegexSearch::open(
            Dir::open_local(directory.path()).unwrap(),
            mode,
            FastRegexSearchLimits {
                max_files: 1,
                ..Default::default()
            },
        ),
        Err(FastRegexError::IndexLimitExceeded("max_files"))
    ));
}

#[test]
fn search_generation_records_visibility_before_and_after_observed_changes() {
    let directory = dir();
    let path = directory.path().join("source.txt");
    fs::write(&path, "before_marker\n").unwrap();
    let index = search(&directory, FastRegexSearchStorage::Memory);
    let before = index.rebuild().unwrap();
    fs::write(&path, "after_marker\n").unwrap();
    let pending = index.search(&query("after_marker")).unwrap();
    assert!(pending.matches.is_empty());
    assert_eq!(pending.statistics.generation, before.generation);
    index.refresh_observed_paths(&[path]).unwrap();
    let current = index.search(&query("after_marker")).unwrap();
    assert_eq!(current.matches.len(), 1);
    assert!(current.statistics.generation > pending.statistics.generation);
}

#[test]
fn parallel_verification_keeps_order_ranges_and_the_global_line_limit() {
    let directory = dir();
    for file in 0..300 {
        fs::write(
            directory.path().join(format!("file-{file:03}.txt")),
            "alpha beta alpha\nnoise\nalpha\n",
        )
        .unwrap();
    }
    let storage = tempfile::tempdir().unwrap();
    let index = search(
        &directory,
        FastRegexSearchStorage::Persistent(storage.path().into()),
    );
    index.rebuild().unwrap();
    for limit in [100, 256, 599, 600, 601] {
        let mut q = query("alpha");
        q.max_results = limit;
        let result = index.search(&q).unwrap();
        assert_eq!(result.matches.len(), limit.min(600));
        assert_eq!(result.limit_hit, limit < 600);
        for (offset, found) in result.matches.iter().enumerate() {
            assert_eq!(
                found.path,
                PathBuf::from(format!("file-{:03}.txt", offset / 2))
            );
            assert_eq!(found.line_number, if offset % 2 == 0 { 1 } else { 3 });
            let mut ranges = vec![FastRegexRange {
                start_byte: 0,
                end_byte: 5,
            }];
            if offset % 2 == 0 {
                ranges.push(FastRegexRange {
                    start_byte: 11,
                    end_byte: 16,
                });
            }
            assert_eq!(found.ranges, ranges);
        }
    }
}

#[test]
fn older_index_format_is_rebuilt_before_searching_the_full_directory() {
    let directory = dir();
    fs::write(directory.path().join("a.txt"), "original_marker\n").unwrap();
    let storage = tempfile::tempdir().unwrap();
    let mode = FastRegexSearchStorage::Persistent(storage.path().into());
    let index = search(&directory, mode.clone());
    let built = index.rebuild().unwrap();
    drop(index);
    let path = base_file(&storage, built.generation, "format.bin");
    let mut format = fs::read(&path).unwrap();
    format[..crate::storage::STORE_VERSION.len()].copy_from_slice(b"ash-fast-regex-v5\0");
    fs::write(path, format).unwrap();
    fs::write(directory.path().join("z.txt"), "new_marker\n").unwrap();
    let reopened = search(&directory, mode);
    assert!(reopened.snapshot().generation > built.generation);
    assert_eq!(reopened.snapshot().indexed_file_count, 2);
    assert_eq!(
        reopened.search(&query("new_marker")).unwrap().matches.len(),
        1
    );
}

#[test]
fn incremental_file_capacity_failure_preserves_the_published_generation() {
    let directory = dir();
    fs::write(directory.path().join("a.txt"), "original_marker\n").unwrap();
    let index = FastRegexSearch::open(
        Dir::open_local(directory.path()).unwrap(),
        FastRegexSearchStorage::Memory,
        FastRegexSearchLimits {
            max_files: 1,
            ..Default::default()
        },
    )
    .unwrap();
    let built = index.rebuild().unwrap();
    let added = directory.path().join("z.txt");
    fs::write(&added, "added_marker\n").unwrap();
    assert!(matches!(
        index.refresh_observed_paths(&[added]),
        Err(FastRegexError::IndexLimitExceeded("max_files"))
    ));
    assert_eq!(index.snapshot(), built);
    assert!(matches!(
        index.reconcile_dir(),
        Err(FastRegexError::IndexLimitExceeded("max_files"))
    ));
    assert_eq!(index.snapshot(), built);
}

#[test]
fn traversal_failure_does_not_publish_an_empty_corpus() {
    let directory = dir();
    let index = search(&directory, FastRegexSearchStorage::Memory);
    fs::remove_dir_all(directory.path()).unwrap();
    assert!(matches!(index.rebuild(), Err(FastRegexError::Io { .. })));
    assert_eq!(index.snapshot().generation, 0);
}
