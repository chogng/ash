use super::*;
use crate::DocumentRevision;
use crate::SyntaxLanguage;

#[test]
fn error_recovery_caches_match_uncached_queries_on_the_same_tree() {
    let text=(0..256).map(|index| format!("// #region part{index}\nfunction item{index}() {{\n\tif (true) {{\n\t  return '😀';\n\t}}\n}}\n// #endregion\n\n")).collect::<String>();
    let mut document =
        SyntaxDocument::open(SyntaxLanguage::Javascript, DocumentRevision::new(1), text).unwrap();
    document.editor_facts(4, &|| false).unwrap();
    let mut seed = 19_u64;
    for revision in 2..62 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let row = (seed as usize) % document.line_count();
        let start = document.text().line_to_byte(row);
        let end = start + document.text().line(row).len_bytes();
        let replacement = match revision % 7 {
            0 => "// #region added\n",
            1 => "// #endregion\n",
            2 => "\n\n",
            3 => "  // indented 😀\n",
            4 => "\t\t// tab\n",
            5 => "",
            _ => "// ordinary\n",
        };
        document
            .update_edits(
                DocumentRevision::new(revision),
                &[SyntaxEdit::replace(start..end, replacement)],
            )
            .unwrap();
        let cached = document
            .editor_facts(4, &|| false)
            .unwrap()
            .delta(None, &[]);
        // Error recovery may differ between an incremental and a cold parse.
        // Rebuild only facts so both queries inspect the identical parser tree.
        *document.editor_cache.borrow_mut() = EditorCache::default();
        let uncached = document
            .editor_facts(4, &|| false)
            .unwrap()
            .delta(None, &[]);
        assert_eq!(
            cached.symbols.items, uncached.symbols.items,
            "symbols revision {revision}"
        );
        assert_eq!(
            cached.folds.items, uncached.folds.items,
            "folds revision {revision}"
        );
        assert_eq!(
            cached.diagnostics.items, uncached.diagnostics.items,
            "diagnostics revision {revision}"
        );
    }
}

#[test]
fn cancelled_tab_size_change_does_not_return_the_previous_folding_result() {
    let document = SyntaxDocument::open(
        SyntaxLanguage::Javascript,
        DocumentRevision::new(1),
        "// start\n\t// tab\n   // spaces\n// end\n",
    )
    .unwrap();
    let original = document.editor_facts(4, &|| false).unwrap();
    let count = std::cell::Cell::new(0);
    assert!(
        document
            .editor_facts(2, &|| {
                count.set(count.get() + 1);
                count.get() > 3
            })
            .is_err()
    );
    let current = document
        .editor_facts(2, &|| false)
        .unwrap()
        .delta(None, &[]);
    assert!(!Arc::ptr_eq(
        &original,
        &document.editor_facts(2, &|| false).unwrap()
    ));
    *document.editor_cache.borrow_mut() = EditorCache::default();
    let fresh = document
        .editor_facts(2, &|| false)
        .unwrap()
        .delta(None, &[]);
    assert_eq!(current.folds.items, fresh.folds.items);
}

#[test]
fn a_minified_unicode_line_sends_only_the_changed_symbol() {
    let text = (0..1000)
        .map(|index| format!("function café{index}() {{return '😀';}} "))
        .collect::<String>();
    let mut document =
        SyntaxDocument::open(SyntaxLanguage::Javascript, DocumentRevision::new(1), &text).unwrap();
    let previous = document.editor_facts(4, &|| false).unwrap();
    let offset = text.find("café500").unwrap() + "café500".len();
    let column = text[..offset].encode_utf16().count();
    document
        .update_edits(
            DocumentRevision::new(2),
            &[SyntaxEdit::insert(offset, "新")],
        )
        .unwrap();
    let current = document.editor_facts(4, &|| false).unwrap();
    let delta = current.delta(Some(&previous), &[[0, column, 0, column, 0, column + 1]]);
    assert!(delta.symbols.items.len() <= 3);
    assert!(
        delta
            .symbols
            .items
            .iter()
            .any(|symbol| symbol.name == "café500新")
    );
    assert!(
        delta
            .symbols
            .items
            .iter()
            .all(|symbol| symbol.name != "café0")
    );
    // The old revision remains immutable after the parser's COW edit.
    assert_eq!(previous.delta(None, &[]).symbols.items[500].name, "café500");
}

#[test]
fn capped_and_empty_fact_patches_stay_within_collection_limits() {
    for limit in [0, 1, 3] {
        let mut document = SyntaxDocument::open_with_limits(
            SyntaxLanguage::Javascript,
            DocumentRevision::new(1),
            "function a() {}\nfunction b() {}\nfunction c() {}\nfunction d() {}\n",
            crate::AnalysisLimits {
                max_symbols: limit,
                max_folding_ranges: limit,
                max_diagnostics: limit,
                ..Default::default()
            },
        )
        .unwrap();
        let previous = document.editor_facts(4, &|| false).unwrap();
        let mut symbols = previous.delta(None, &[]).symbols.items;
        document
            .update_edits(DocumentRevision::new(2), &[SyntaxEdit::insert(9, "X")])
            .unwrap();
        let current = document.editor_facts(4, &|| false).unwrap();
        let patch = current.delta(Some(&previous), &[[0, 9, 0, 9, 0, 10]]);
        // The edited declaration is at the beginning; later rows do not move.
        symbols.splice(
            patch.symbols.start..patch.symbols.start + patch.symbols.delete_count,
            patch.symbols.items,
        );
        assert_eq!(symbols, current.delta(None, &[]).symbols.items);
        assert!(symbols.len() <= limit);
        assert!(current.delta(None, &[]).folds.items.len() <= limit);
        assert!(current.delta(None, &[]).diagnostics.items.len() <= limit);
    }
}

#[test]
fn distant_batched_edits_keep_independent_line_scan_windows() {
    let text=(0..16_666).map(|index| format!("function item{index}() {{\n  const value = '😀';\n  if (value) {{\n    return value;\n  }}\n}}\n")).collect::<String>();
    let mut document =
        SyntaxDocument::open(SyntaxLanguage::Javascript, DocumentRevision::new(1), &text).unwrap();
    document.editor_facts(4, &|| false).unwrap();
    let tail = text.rfind("  const value").unwrap();
    document
        .update_edits(
            DocumentRevision::new(2),
            &[
                SyntaxEdit::insert(0, "// head\n"),
                SyntaxEdit::insert(tail, "  "),
            ],
        )
        .unwrap();
    let calls = std::cell::Cell::new(0);
    let cached = document
        .editor_facts(4, &|| {
            calls.set(calls.get() + 1);
            false
        })
        .unwrap()
        .delta(None, &[]);
    assert!(
        calls.get() < 800,
        "distant edits must not rescan their intervening lines: {}",
        calls.get()
    );
    *document.editor_cache.borrow_mut() = EditorCache::default();
    let fresh = document
        .editor_facts(4, &|| false)
        .unwrap()
        .delta(None, &[]);
    assert_eq!(cached.symbols.items, fresh.symbols.items);
    assert_eq!(cached.folds.items, fresh.folds.items);
}

#[test]
fn cancelled_initial_facts_and_unused_fact_caches_do_not_retain_stale_edits() {
    let text = "function café() {\n  return '😀';\n}\n".repeat(256);
    let mut document =
        SyntaxDocument::open(SyntaxLanguage::Javascript, DocumentRevision::new(1), text).unwrap();
    let visits = std::cell::Cell::new(0);
    document
        .editor_facts(4, &|| {
            visits.set(visits.get() + 1);
            false
        })
        .unwrap();
    *document.editor_cache.borrow_mut() = EditorCache::default();
    let cancelled = std::cell::Cell::new(0);
    assert!(
        document
            .editor_facts(4, &|| {
                cancelled.set(cancelled.get() + 1);
                cancelled.get() > visits.get() - 10
            })
            .is_err()
    );
    document
        .update_edits(
            DocumentRevision::new(2),
            &[SyntaxEdit::insert(0, "// changed😀\r\n")],
        )
        .unwrap();
    assert!(document.editor_cache.borrow().dirty.is_empty());
    let cached = document
        .editor_facts(4, &|| false)
        .unwrap()
        .delta(None, &[]);
    *document.editor_cache.borrow_mut() = EditorCache::default();
    let uncached = document
        .editor_facts(4, &|| false)
        .unwrap()
        .delta(None, &[]);
    assert_eq!(cached.symbols.items, uncached.symbols.items);
    assert_eq!(cached.folds.items, uncached.folds.items);
    *document.editor_cache.borrow_mut() = EditorCache::default();
    for revision in 3..24 {
        document
            .update_edits(
                DocumentRevision::new(revision),
                &[SyntaxEdit::insert(0, "// unused\n")],
            )
            .unwrap();
        assert!(document.editor_cache.borrow().dirty.is_empty());
    }
}

#[test]
fn leading_newlines_move_region_origins_without_rescanning_the_region() {
    let text = "// #region all\n".to_owned()
        + &"function item() {\n  return '😀';\n}\n".repeat(33_332)
        + "// #endregion\n";
    let mut document =
        SyntaxDocument::open(SyntaxLanguage::Javascript, DocumentRevision::new(1), text).unwrap();
    document.editor_facts(4, &|| false).unwrap();
    document
        .update_edits(
            DocumentRevision::new(2),
            &[SyntaxEdit::insert(0, "// added\n")],
        )
        .unwrap();
    let calls = std::cell::Cell::new(0);
    let cached = document
        .editor_facts(4, &|| {
            calls.set(calls.get() + 1);
            false
        })
        .unwrap()
        .delta(None, &[]);
    assert!(
        calls.get() < 500,
        "an unchanged region must converge after its origin moves: {}",
        calls.get()
    );
    assert_eq!(cached.folds.items[0].start_line_index, 1);
    assert_eq!(cached.folds.items[0].kind, Some("region"));
    *document.editor_cache.borrow_mut() = EditorCache::default();
    let fresh = document
        .editor_facts(4, &|| false)
        .unwrap()
        .delta(None, &[]);
    assert_eq!(cached.folds.items, fresh.folds.items);
}

#[test]
fn first_open_skips_single_line_expression_descendants() {
    let expression = std::iter::repeat_n("value", 10_000)
        .collect::<Vec<_>>()
        .join(" + ");
    let text = format!("function outer(value) {{\n  return {expression};\n}}\n");
    let document =
        SyntaxDocument::open(SyntaxLanguage::Javascript, DocumentRevision::new(1), text).unwrap();
    let visits = std::cell::Cell::new(0);
    let facts = document
        .editor_facts(4, &|| {
            visits.set(visits.get() + 1);
            false
        })
        .unwrap()
        .delta(None, &[]);
    assert!(
        visits.get() < 100,
        "valid one-line expressions need no fold/diagnostic traversal: {}",
        visits.get()
    );
    assert_eq!(facts.symbols.items.len(), 1);
    assert_eq!(facts.symbols.items[0].name, "outer");
    assert_eq!(facts.folds.items[0].start_line_index, 0);
    assert_eq!(facts.folds.items[0].end_line_index, 2);
    assert!(facts.diagnostics.items.is_empty());
}

#[test]
fn pruned_editor_walk_matches_full_diagnostic_walk() {
    for text in [
        "function outer() {\n const label = '😀'; const result = (1 + );\n}\n",
        "function broken( { return '中😀'; }",
        "function outer() {\n if (true { return 1; }\n}\n",
        "function outer() {\n /* a\n comment */\n const nested = () => {\n return 1;\n };\n}\n",
    ] {
        let document =
            SyntaxDocument::open(SyntaxLanguage::Javascript, DocumentRevision::new(1), text)
                .unwrap();
        let facts = document
            .editor_facts(4, &|| false)
            .unwrap()
            .delta(None, &[]);
        assert!(!document.tree.root_node().is_error());
        let expected =
            super::super::collect_diagnostics(&document.tree, document.limits.max_diagnostics)
                .into_iter()
                .map(|diagnostic| EditorDiagnostic {
                    range: [
                        diagnostic.range.start.row,
                        document.utf16_column(diagnostic.range.start),
                        diagnostic.range.end.row,
                        document.utf16_column(diagnostic.range.end),
                    ],
                    kind: diagnostic.kind,
                })
                .collect::<Vec<_>>();
        assert_eq!(facts.diagnostics.items, expected, "{text}");
        for fold in super::super::collect_folding_ranges(
            &document.tree,
            &document.configuration.folds,
            &document.text,
            document.limits.max_folding_ranges,
        ) {
            assert!(
                facts
                    .folds
                    .items
                    .iter()
                    .any(|cached| cached.start_line_index == fold.range.start.row
                        && cached.end_line_index == fold.range.end.row)
            );
        }
    }
}

#[test]
#[ignore = "Manual comparison of borrowed initial input and Rope parser input"]
fn initial_parse_input_latency_probe() {
    for size in [1_000, 10_000, 100_000] {
        let text = (0..size / 6).map(|i| format!("export function item{i}(value) {{\n  const label = '😀';\n  const offset = {i};\n  return value + offset;\n}}\n\n")).collect::<String>();
        let rope = Rope::from_str(&text);
        for sample in 0..7 {
            for contiguous in [sample % 2 == 0, sample % 2 != 0] {
                let mut parser = super::super::Parser::new();
                super::super::LanguageConfiguration::load(SyntaxLanguage::Javascript, &mut parser)
                    .unwrap();
                let start = std::time::Instant::now();
                let tree = if contiguous {
                    parser.parse(&text, None).unwrap()
                } else {
                    super::super::parse_rope(&mut parser, &rope, None).unwrap()
                };
                let elapsed = start.elapsed().as_secs_f64() * 1000.;
                assert!(!tree.root_node().has_error());
                assert_eq!(tree.root_node().end_byte(), text.len());
                println!(
                    "PARSE_INPUT size={size} contiguous={contiguous} sample={sample} ms={elapsed}"
                );
            }
        }
    }
}

#[test]
fn unchanged_replacements_advance_revision_without_invalidating_markdown() {
    let text = (0..20_000)
        .map(|i| format!("# Section{i}\n\ncontent 😀中文\n\ntext\n"))
        .collect::<String>();
    let mut document =
        SyntaxDocument::open(SyntaxLanguage::Markdown, DocumentRevision::new(1), &text).unwrap();
    let original = document.editor_facts(4, &|| false).unwrap();
    assert_eq!(original.folds.len(), 20_000);
    assert_eq!(original.folds.last().unwrap().start_line_index, 99_995);
    assert_eq!(original.folds.last().unwrap().end_line_index, 99_999);
    let highlight = document.editor_highlight(0..5, &|| false).unwrap();
    let tree_id = document.tree.root_node().id();
    let injections = document.injection_cache.borrow().len();
    for (revision, edits) in [
        (2, vec![SyntaxEdit::replace(0..text.len(), &text)]),
        (3, vec![]),
        (
            4,
            vec![
                SyntaxEdit::replace(0..10, "# Section0"),
                SyntaxEdit::insert(text.len(), ""),
            ],
        ),
    ] {
        let effective = document
            .update_edits(DocumentRevision::new(revision), &edits)
            .unwrap();
        assert!(effective.is_empty());
        assert_eq!(document.revision(), DocumentRevision::new(revision));
        assert_eq!(
            document.tree.root_node().id(),
            tree_id,
            "unchanged text must retain its parsed tree"
        );
        assert_eq!(document.injection_cache.borrow().len(), injections);
        let facts = document.editor_facts(4, &|| false).unwrap();
        assert_eq!(facts.revision(), DocumentRevision::new(revision));
        assert!(Arc::ptr_eq(&original.nodes[0], &facts.nodes[0]));
        assert!(Arc::ptr_eq(&original.nodes[19_999], &facts.nodes[19_999]));
        assert_eq!(
            document.editor_highlight(0..5, &|| false).unwrap(),
            highlight
        );
        assert_eq!(facts.delta(None, &[]).symbols.items.len(), 20_000);
        if revision == 2 {
            // Consumers move old coordinates through the reported snapshot edit
            // before applying the patch, even when its replacement text is equal.
            let edit = [
                0,
                0,
                document.line_count() - 1,
                0,
                document.line_count() - 1,
                0,
            ];
            let patch = facts.delta(Some(&original), &[edit]);
            let mut folds = original
                .folds
                .iter()
                .cloned()
                .map(|mut fold| {
                    fold.start_line_index = shift_row(fold.start_line_index, edit);
                    fold.end_line_index = shift_row(fold.end_line_index, edit);
                    fold
                })
                .collect::<Vec<_>>();
            folds.splice(
                patch.folds.start..patch.folds.start + patch.folds.delete_count,
                patch.folds.items,
            );
            assert_eq!(folds, *facts.folds);
        }
    }
    // Normalization must not turn invalid, overlapping original ranges into valid edits.
    assert!(matches!(
        document.update_edits(
            DocumentRevision::new(5),
            &[
                SyntaxEdit::replace(0..10, "# Section0"),
                SyntaxEdit::insert(5, ""),
            ]
        ),
        Err(SyntaxError::OverlappingEdits)
    ));
    assert_eq!(document.revision(), DocumentRevision::new(4));
}

#[test]
fn broad_replacements_preserve_utf8_boundaries_and_untouched_fact_windows() {
    let text = format!(
        "# café\n\né😀\n\n{}",
        (0..1000)
            .map(|i| format!("# Tail{i}\n\ntext\n"))
            .collect::<String>()
    );
    let mut document =
        SyntaxDocument::open(SyntaxLanguage::Markdown, DocumentRevision::new(1), &text).unwrap();
    document.editor_facts(4, &|| false).unwrap();
    for (revision, replacement) in [(2, text.replace("é😀", "ê🦀")), (4, text.clone())] {
        document
            .update_edits(
                DocumentRevision::new(revision),
                &[SyntaxEdit::replace(
                    0..document.text.len_bytes(),
                    &replacement,
                )],
            )
            .unwrap();
        assert!(
            document
                .editor_cache
                .borrow()
                .dirty
                .iter()
                .all(|range| range.end < 100),
            "an unchanged suffix must remain outside the fact invalidation window"
        );
        let dirty = document.editor_cache.borrow().dirty.clone();
        document
            .update_edits(
                DocumentRevision::new(revision + 1),
                &[SyntaxEdit::replace(0..replacement.len(), &replacement)],
            )
            .unwrap();
        assert_eq!(document.editor_cache.borrow().dirty, dirty);
        let fresh = SyntaxDocument::open(
            SyntaxLanguage::Markdown,
            DocumentRevision::new(revision + 1),
            &replacement,
        )
        .unwrap();
        assert_eq!(document.text().to_string(), replacement);
        assert_eq!(
            document.tree.root_node().to_sexp(),
            fresh.tree.root_node().to_sexp()
        );
        let cached = document
            .editor_facts(4, &|| false)
            .unwrap()
            .delta(None, &[]);
        let cold = fresh.editor_facts(4, &|| false).unwrap().delta(None, &[]);
        assert_eq!(cached.symbols.items, cold.symbols.items);
        assert_eq!(cached.folds.items, cold.folds.items);
        assert_eq!(cached.diagnostics.items, cold.diagnostics.items);
        assert_eq!(
            document.editor_highlight(0..5, &|| false).unwrap(),
            fresh.editor_highlight(0..5, &|| false).unwrap()
        );
    }
}

#[test]
#[ignore = "Manual comparison of Markdown range edits and host snapshot replacements"]
fn markdown_snapshot_edit_latency_probe() {
    enum EditMode {
        Unchanged,
        Snapshot,
        Range,
    }
    let text = (0..20_000)
        .map(|i| format!("# Section{i}\n\ncontent 😀中文\n\ntext\n"))
        .collect::<String>();
    for (mode, label) in [
        (EditMode::Unchanged, "unchanged"),
        (EditMode::Snapshot, "snapshot"),
        (EditMode::Range, "range"),
    ] {
        let mut document =
            SyntaxDocument::open(SyntaxLanguage::Markdown, DocumentRevision::new(1), &text)
                .unwrap();
        document.editor_facts(4, &|| false).unwrap();
        for sample in 0..36 {
            let inserted = sample % 2 == 0;
            let replacement = if inserted {
                format!("{} PERF_MARK{}", &text[..10], &text[10..])
            } else {
                text.clone()
            };
            let edit = match mode {
                EditMode::Unchanged => SyntaxEdit::replace(0..text.len(), &text),
                EditMode::Snapshot => {
                    SyntaxEdit::replace(0..document.text.len_bytes(), replacement)
                }
                EditMode::Range if inserted => SyntaxEdit::insert(10, " PERF_MARK"),
                EditMode::Range => SyntaxEdit::delete(10..20),
            };
            let started = std::time::Instant::now();
            document
                .update_edits(DocumentRevision::new(sample + 2), &[edit])
                .unwrap();
            let ms = started.elapsed().as_secs_f64() * 1000.;
            document.editor_facts(4, &|| false).unwrap();
            println!("MARKDOWN_SNAPSHOT mode={label} sample={sample} ms={ms:.3}");
        }
    }
}
