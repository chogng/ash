use crate::{
    AnalysisLimits, DocumentRevision, DocumentSymbolKind, SyntaxDocument, SyntaxEdit, SyntaxError,
    SyntaxLanguage, SyntaxTokenKind,
};

const RUST_SOURCE: &str = r#"mod engine {
    /// Adds two values.
    pub fn add(left: i32, right: i32) -> i32 {
        left + right
    }
}
"#;

#[test]
fn editor_facts_resume_completed_subtrees_after_cancellation_and_edits() {
    use std::cell::Cell;

    let text = (0..100)
        .map(|index| format!("function item{index}() {{\n  return '😀';\n}}\n"))
        .collect::<String>();
    let mut document =
        SyntaxDocument::open(SyntaxLanguage::Javascript, DocumentRevision::new(1), &text).unwrap();
    let interrupted = Cell::new(0);
    assert!(
        document
            .editor_facts_snapshot(4, &|| {
                interrupted.set(interrupted.get() + 1);
                interrupted.get() > 150
            })
            .is_err()
    );

    let resumed = Cell::new(0);
    let facts = document
        .editor_facts_snapshot(4, &|| {
            resumed.set(resumed.get() + 1);
            false
        })
        .unwrap();
    let fresh =
        SyntaxDocument::open(SyntaxLanguage::Javascript, DocumentRevision::new(1), &text).unwrap();
    let cold = Cell::new(0);
    assert_eq!(
        facts,
        fresh
            .editor_facts_snapshot(4, &|| {
                cold.set(cold.get() + 1);
                false
            })
            .unwrap()
    );
    assert!(
        resumed.get() < cold.get(),
        "completed subtree visits must be reused"
    );

    document
        .update_edits(
            DocumentRevision::new(2),
            &[SyntaxEdit::replace(
                0..text.len(),
                "function changed() { return 1; }\n",
            )],
        )
        .unwrap();
    let fresh = SyntaxDocument::open(
        SyntaxLanguage::Javascript,
        DocumentRevision::new(2),
        document.text().to_string(),
    )
    .unwrap();
    assert_eq!(
        document.editor_facts_snapshot(4, &|| false).unwrap(),
        fresh.editor_facts_snapshot(4, &|| false).unwrap()
    );
}

const TYPESCRIPT_SOURCE: &str = r#"export class Editor {
    render(value: string): string {
        return value.toUpperCase();
    }
}
"#;

#[test]
fn json_snapshot_contains_structural_tokens_and_folds() {
    let document = SyntaxDocument::open(
        SyntaxLanguage::Json,
        DocumentRevision::new(3),
        "{\n  \"enabled\": true,\n  \"count\": 2\n}\n",
    )
    .expect("JSON grammar should load");

    let snapshot = document.snapshot();

    assert!(!snapshot.has_errors());
    assert!(
        snapshot
            .tokens()
            .iter()
            .any(|token| token.kind == SyntaxTokenKind::String)
    );
    assert!(
        snapshot
            .tokens()
            .iter()
            .any(|token| token.kind == SyntaxTokenKind::Constant)
    );
    assert!(
        snapshot
            .tokens()
            .iter()
            .any(|token| token.kind == SyntaxTokenKind::Number)
    );
    assert!(
        snapshot
            .folding_ranges()
            .iter()
            .any(|range| range.range.start.row == 0 && range.range.end.row == 3)
    );
}

#[test]
fn jsonc_snapshot_uses_comment_capable_json_grammar() {
    let document = SyntaxDocument::open(
        SyntaxLanguage::Jsonc,
        DocumentRevision::new(5),
        "{\n  // Keep this local.\n  \"enabled\": true\n}\n",
    )
    .expect("JSONC grammar should load");

    let snapshot = document.snapshot();

    assert!(!snapshot.has_errors());
    assert!(
        snapshot
            .tokens()
            .iter()
            .any(|token| token.kind == SyntaxTokenKind::Comment)
    );
    assert_eq!(SyntaxLanguage::Json.id(), "json");
    assert_eq!(SyntaxLanguage::Jsonc.id(), "jsonc");
}

#[test]
fn shell_snapshot_highlights_command_operators_variables_and_comments() {
    let source = "just app && echo \"$USER\" # run app\n";
    let document = SyntaxDocument::open(SyntaxLanguage::Shell, DocumentRevision::new(6), source)
        .expect("Shell grammar should load");

    let snapshot = document.snapshot();
    let highlighted = snapshot
        .tokens()
        .iter()
        .map(|token| (&source[token.range.bytes.clone()], token.kind))
        .collect::<Vec<_>>();

    assert!(!snapshot.has_errors());
    assert!(highlighted.contains(&("just", SyntaxTokenKind::Function)));
    assert!(highlighted.contains(&("&&", SyntaxTokenKind::Operator)));
    assert!(highlighted.contains(&("echo", SyntaxTokenKind::Function)));
    assert!(highlighted.contains(&("# run app", SyntaxTokenKind::Comment)));
    assert_eq!(SyntaxLanguage::Shell.id(), "shell");
}

#[test]
fn ecmascript_snapshots_support_javascript_typescript_and_tsx() {
    let javascript = SyntaxDocument::open(
        SyntaxLanguage::Javascript,
        DocumentRevision::new(8),
        "export function render(value) { return value + 1; }\n",
    )
    .expect("JavaScript grammar should load")
    .snapshot();
    let typescript = SyntaxDocument::open(
        SyntaxLanguage::Typescript,
        DocumentRevision::new(9),
        TYPESCRIPT_SOURCE,
    )
    .expect("TypeScript grammar should load")
    .snapshot();
    let tsx = SyntaxDocument::open(
        SyntaxLanguage::Typescriptreact,
        DocumentRevision::new(10),
        "export const App = () => <main>Hello</main>;\n",
    )
    .expect("TSX grammar should load")
    .snapshot();

    assert!(!javascript.has_errors());
    assert!(!typescript.has_errors());
    assert!(!tsx.has_errors());
    assert!(
        javascript
            .tokens()
            .iter()
            .any(|token| token.kind == SyntaxTokenKind::Function)
    );
    assert!(
        typescript
            .tokens()
            .iter()
            .any(|token| token.kind == SyntaxTokenKind::Type)
    );
    assert!(
        typescript
            .folding_ranges()
            .iter()
            .any(|range| range.range.start.row < range.range.end.row)
    );
    assert_eq!(SyntaxLanguage::Javascript.id(), "javascript");
    assert_eq!(SyntaxLanguage::Javascriptreact.id(), "javascriptreact");
    assert_eq!(SyntaxLanguage::Typescript.id(), "typescript");
    assert_eq!(SyntaxLanguage::Typescriptreact.id(), "typescriptreact");
}

#[test]
fn rust_snapshot_contains_tokens_folds_and_symbols() {
    let document =
        SyntaxDocument::open(SyntaxLanguage::Rust, DocumentRevision::new(7), RUST_SOURCE)
            .expect("Rust grammar should load");

    let snapshot = document.snapshot();

    assert_eq!(snapshot.revision(), DocumentRevision::new(7));
    assert!(!snapshot.has_errors());
    assert!(
        snapshot
            .tokens()
            .iter()
            .any(|token| token.kind == SyntaxTokenKind::Keyword)
    );
    assert!(
        snapshot
            .tokens()
            .iter()
            .any(|token| token.kind == SyntaxTokenKind::Function)
    );
    assert!(
        snapshot
            .folding_ranges()
            .iter()
            .any(|range| range.range.start.row < range.range.end.row)
    );
    assert!(
        snapshot
            .symbols()
            .iter()
            .any(|symbol| symbol.name == "engine" && symbol.kind == DocumentSymbolKind::Module)
    );
    assert!(
        snapshot
            .symbols()
            .iter()
            .any(|symbol| symbol.name == "add" && symbol.kind == DocumentSymbolKind::Function)
    );
}

#[test]
fn upstream_class_tags_project_to_struct_symbols() {
    let document = SyntaxDocument::open(
        SyntaxLanguage::Rust,
        DocumentRevision::new(1),
        "pub struct UserAuthenticationService;\n",
    )
    .expect("Rust grammar should load");

    assert!(document.snapshot().symbols().iter().any(|symbol| {
        symbol.name == "UserAuthenticationService" && symbol.kind == DocumentSymbolKind::Struct
    }));
}

#[test]
fn incremental_edit_updates_text_revision_positions_and_symbols() {
    let mut document = SyntaxDocument::open(
        SyntaxLanguage::Rust,
        DocumentRevision::new(1),
        "fn first() {}\n",
    )
    .expect("Rust grammar should load");
    let name_start = document
        .text()
        .to_string()
        .find("first")
        .expect("fixture should contain the function name");
    let edit = SyntaxEdit::replace(name_start..name_start + "first".len(), "second");

    let snapshot = document
        .apply_edit(DocumentRevision::new(2), &edit)
        .expect("valid edit should apply");

    assert_eq!(document.text(), "fn second() {}\n");
    assert_eq!(document.revision(), DocumentRevision::new(2));
    assert_eq!(snapshot.revision(), DocumentRevision::new(2));
    assert!(
        snapshot
            .symbols()
            .iter()
            .any(|symbol| symbol.name == "second")
    );
    assert!(
        !snapshot
            .symbols()
            .iter()
            .any(|symbol| symbol.name == "first")
    );
}

#[test]
fn multiline_edit_maintains_byte_columns_for_following_edits() {
    let mut document = SyntaxDocument::open(
        SyntaxLanguage::Rust,
        DocumentRevision::new(1),
        "fn main() {\n    work();\n}\n",
    )
    .expect("Rust grammar should load");
    let work_start = document
        .text()
        .to_string()
        .find("work")
        .expect("fixture should contain work");
    document
        .apply_edit(
            DocumentRevision::new(2),
            &SyntaxEdit::replace(work_start..work_start + 4, "first();\n    second"),
        )
        .expect("multiline edit should apply");
    let second_start = document
        .text()
        .to_string()
        .find("second")
        .expect("first edit should insert second");

    let snapshot = document
        .apply_edit(
            DocumentRevision::new(3),
            &SyntaxEdit::replace(second_start..second_start + 6, "done"),
        )
        .expect("following edit should use the updated line index");

    assert_eq!(
        document.text().to_string(),
        "fn main() {\n    first();\n    done();\n}\n"
    );
    assert_eq!(snapshot.revision(), DocumentRevision::new(3));
    assert!(!snapshot.has_errors());
}

#[test]
fn atomic_edit_batch_preserves_one_host_revision() {
    let mut document = SyntaxDocument::open(
        SyntaxLanguage::Rust,
        DocumentRevision::new(4),
        "fn first() {}\nfn second() {}\n",
    )
    .expect("Rust grammar should load");
    let first = document.text().to_string().find("first").unwrap();
    let second = document.text().to_string().find("second").unwrap();

    let snapshot = document
        .apply_edits(
            DocumentRevision::new(5),
            &[
                SyntaxEdit::replace(first..first + 5, "one"),
                SyntaxEdit::replace(second..second + 6, "two"),
            ],
        )
        .expect("non-overlapping edits should apply atomically");

    assert_eq!(document.text(), "fn one() {}\nfn two() {}\n");
    assert_eq!(snapshot.revision(), DocumentRevision::new(5));
    assert!(snapshot.symbols().iter().any(|symbol| symbol.name == "one"));
    assert!(snapshot.symbols().iter().any(|symbol| symbol.name == "two"));
}

#[test]
fn overlapping_edit_batch_does_not_mutate_the_document() {
    let mut document = SyntaxDocument::open(
        SyntaxLanguage::Rust,
        DocumentRevision::new(8),
        "fn original() {}\n",
    )
    .expect("Rust grammar should load");

    let error = document
        .apply_edits(
            DocumentRevision::new(9),
            &[
                SyntaxEdit::replace(3..11, "first"),
                SyntaxEdit::replace(5..9, "second"),
            ],
        )
        .expect_err("overlapping edits should fail");

    assert!(matches!(error, SyntaxError::OverlappingEdits));
    assert_eq!(document.text(), "fn original() {}\n");
    assert_eq!(document.revision(), DocumentRevision::new(8));
}

#[test]
fn deleting_a_complete_line_updates_following_symbol_positions() {
    let first_line = "fn first() {}\n";
    let mut document = SyntaxDocument::open(
        SyntaxLanguage::Rust,
        DocumentRevision::new(1),
        format!("{first_line}fn second() {{}}\n"),
    )
    .expect("Rust grammar should load");

    document
        .apply_edit(
            DocumentRevision::new(2),
            &SyntaxEdit::delete(0..first_line.len()),
        )
        .expect("complete line deletion should apply");
    let second_start = document
        .text()
        .to_string()
        .find("second")
        .expect("second function should remain");
    let snapshot = document
        .apply_edit(
            DocumentRevision::new(3),
            &SyntaxEdit::replace(second_start..second_start + 6, "renamed"),
        )
        .expect("following edit should use shifted line starts");

    let symbol = snapshot
        .symbols()
        .iter()
        .find(|symbol| symbol.name == "renamed")
        .expect("renamed function should be indexed");
    assert_eq!(symbol.selection_range.start.row, 0);
    assert_eq!(document.text(), "fn renamed() {}\n");
}

#[test]
fn invalid_edits_do_not_mutate_the_document() {
    let mut document = SyntaxDocument::open(
        SyntaxLanguage::Rust,
        DocumentRevision::new(4),
        "fn π() {}\n",
    )
    .expect("Rust grammar should load");
    let original = document.text().to_string();
    let inside_pi = original.find('π').expect("fixture should contain pi") + 1;

    let error = document
        .apply_edit(
            DocumentRevision::new(5),
            &SyntaxEdit::insert(inside_pi, "x"),
        )
        .expect_err("edit inside a UTF-8 scalar should fail");

    assert!(matches!(
        error,
        SyntaxError::InvalidEditBoundary { offset } if offset == inside_pi
    ));
    assert_eq!(document.text(), original);
    assert_eq!(document.revision(), DocumentRevision::new(4));
}

#[test]
fn revisions_must_increase_and_document_limits_apply_before_mutation() {
    let limits = AnalysisLimits {
        max_document_bytes: 16,
        ..AnalysisLimits::default()
    };
    let mut document = SyntaxDocument::open_with_limits(
        SyntaxLanguage::Rust,
        DocumentRevision::new(9),
        "fn a() {}\n",
        limits,
    )
    .expect("fixture should fit");

    let stale = document
        .apply_edit(DocumentRevision::new(9), &SyntaxEdit::insert(0, "pub "))
        .expect_err("equal revision should fail");
    assert!(matches!(stale, SyntaxError::NonIncreasingRevision { .. }));

    let oversized = document
        .apply_edit(
            DocumentRevision::new(10),
            &SyntaxEdit::insert(0, "pub(crate) "),
        )
        .expect_err("oversized result should fail");
    assert!(matches!(oversized, SyntaxError::DocumentTooLarge { .. }));
    assert_eq!(document.text(), "fn a() {}\n");
    assert_eq!(document.revision(), DocumentRevision::new(9));
}

#[test]
fn zero_collection_limits_produce_an_empty_bounded_snapshot() {
    let limits = AnalysisLimits {
        max_tokens: 0,
        max_folding_ranges: 0,
        max_selection_ranges: 0,
        max_symbols: 0,
        max_diagnostics: 0,
        ..AnalysisLimits::default()
    };
    let document = SyntaxDocument::open_with_limits(
        SyntaxLanguage::Rust,
        DocumentRevision::new(1),
        "fn broken( {\n",
        limits,
    )
    .expect("recoverable syntax errors should still produce a document");

    let snapshot = document.snapshot();

    assert!(snapshot.tokens().is_empty());
    assert!(snapshot.folding_ranges().is_empty());
    assert!(document.selection_ranges(0..0).unwrap().is_empty());
    assert!(snapshot.symbols().is_empty());
    assert!(snapshot.diagnostics().is_empty());
    assert!(snapshot.has_errors());
}

#[test]
fn selection_ranges_form_named_revision_bound_scopes_without_the_document_root() {
    let source = "fn outer() {\n    let value = call(1 + 2);\n}\n";
    let document = SyntaxDocument::open(SyntaxLanguage::Rust, DocumentRevision::new(7), source)
        .expect("Rust grammar should load");
    let cursor = source.find("value").expect("identifier offset");
    let selections = document
        .selection_ranges(cursor..cursor + "value".len())
        .expect("selection range should be valid");
    let scopes = selections
        .iter()
        .map(|selection| &source[selection.range.bytes.clone()])
        .collect::<Vec<_>>();

    assert!(scopes.contains(&"value"));
    assert!(scopes.iter().any(|scope| scope.starts_with("let value")));
    assert!(scopes.iter().any(|scope| scope.starts_with("fn outer")));
    assert!(
        !selections
            .iter()
            .any(|selection| selection.range.bytes == (0..source.len()))
    );
    assert!(scopes.windows(2).all(|pair| pair[0].len() <= pair[1].len()));
    assert_eq!(document.revision(), DocumentRevision::new(7));
}

#[test]
fn selection_ranges_reject_invalid_utf8_boundaries() {
    let document = SyntaxDocument::open(
        SyntaxLanguage::Rust,
        DocumentRevision::new(1),
        "fn café() {}\n",
    )
    .expect("Rust grammar should load");

    let error = document
        .selection_ranges(7..8)
        .expect_err("a range inside the multibyte character must fail");

    assert!(matches!(
        error,
        SyntaxError::InvalidSelectionBoundary { offset: 7 }
    ));
}

#[test]
fn typescript_tags_include_javascript_declarations_and_typescript_extensions() {
    let source = "function zebra() { function nested() {} }\ninterface Shape { draw(): void; }\n";
    for language in [SyntaxLanguage::Typescript, SyntaxLanguage::Typescriptreact] {
        let document = SyntaxDocument::open(language, DocumentRevision::new(1), source)
            .expect("TypeScript tags should compile with the base JavaScript query");
        let snapshot = document.snapshot();
        let names = snapshot
            .symbols()
            .iter()
            .map(|symbol| symbol.name.as_str())
            .collect::<Vec<_>>();
        assert!(names.contains(&"zebra"));
        assert!(names.contains(&"nested"));
        assert!(names.contains(&"Shape"));
        assert!(names.contains(&"draw"));
    }
}

#[test]
fn shared_editor_queries_reuse_incremental_tree_with_utf16_and_facts() {
    for (language, source, name) in [
        (
            SyntaxLanguage::Javascript,
            "// 😀\r\nexport function café() {\r\n  return [\"😀\", 1];\r\n}\r\n",
            "café",
        ),
        (
            SyntaxLanguage::Typescript,
            "// 😀\nexport function café(): number {\n  return 1;\n}\n",
            "café",
        ),
        (
            SyntaxLanguage::Rust,
            "// 😀\npub fn café() -> i32 {\n  1\n}\n",
            "café",
        ),
    ] {
        let mut document =
            SyntaxDocument::open(language, DocumentRevision::new(1), source).unwrap();
        let rows = document.editor_highlight(0..4, &|| false).unwrap();
        assert!(
            rows[0]
                .tokens
                .iter()
                .any(|token| token.name.starts_with("comment") && token.end == 5)
        );
        assert!(
            rows[1]
                .tokens
                .iter()
                .any(|token| token.name.contains("function"))
        );
        let (facts, folds) = document.editor_facts_snapshot(4, &|| false).unwrap();
        assert!(facts.tokens().is_empty());
        assert_eq!(facts.symbols()[0].name, name);
        assert!(
            folds
                .iter()
                .any(|fold| fold.start_line_index == 1 && fold.end_line_index == 3)
        );
        let pairs = document.editor_brackets(&[1..3], 4, &|| false).unwrap();
        assert!(
            pairs
                .iter()
                .any(|pair| pair.text == "{" && pair.closing.is_some())
        );
        let start = source.find(name).unwrap() + name.len();
        document
            .update_edits(DocumentRevision::new(2), &[SyntaxEdit::insert(start, "新")])
            .unwrap();
        let fresh = SyntaxDocument::open(
            language,
            DocumentRevision::new(2),
            document.text().to_string(),
        )
        .unwrap();
        assert_eq!(
            document.editor_highlight(0..4, &|| false).unwrap(),
            fresh.editor_highlight(0..4, &|| false).unwrap()
        );
        assert_eq!(
            document.editor_facts_snapshot(4, &|| false).unwrap(),
            fresh.editor_facts_snapshot(4, &|| false).unwrap()
        );
        assert_eq!(
            document
                .editor_facts_snapshot(4, &|| false)
                .unwrap()
                .0
                .symbols()[0]
                .name,
            "café新"
        );
        let preview = document
            .editor_preview(0, &["// temporary".into()], &|| false)
            .unwrap();
        assert!(!preview[0].tokens.is_empty());
        assert_eq!(document.text(), fresh.text());
        assert_eq!(document.revision().value(), 2);
        assert!(document.editor_highlight(0..4, &|| true).is_err());
        assert!(document.editor_facts_snapshot(4, &|| true).is_err());
    }
}

#[test]
fn shared_editor_folding_keeps_comments_regions_and_import_containers() {
    let document = SyntaxDocument::open(SyntaxLanguage::Typescript, DocumentRevision::new(1), "import {\n  a,\n  b\n} from 'x';\n// #region section\n/* hello\n world */\n// #endregion\n").unwrap();
    let (_, folds) = document.editor_facts_snapshot(4, &|| false).unwrap();
    assert!(
        folds
            .iter()
            .any(|fold| fold.start_line_index == 0 && fold.end_line_index == 3)
    );
    assert!(folds.iter().any(|fold| fold.kind == Some("comment")));
    assert!(folds.iter().any(|fold| fold.kind == Some("region")));
}

#[test]
fn package_folding_rules_match_the_worker_corpus_after_edits_and_undo() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/languages/folding.json"
    ))
    .unwrap();
    for fixture in fixtures.as_array().unwrap() {
        let id = fixture["language"].as_str().unwrap();
        let identity = ash_language::LanguageId::parse(id).unwrap();
        let language = SyntaxLanguage::for_language(&identity).unwrap();
        assert_eq!(
            ash_language::folding_rules(id).off_side(),
            fixture["offSide"].as_bool().unwrap(),
            "{id}"
        );
        let source = fixture["text"].as_str().unwrap();
        let expected = fixture["regions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|range| {
                (
                    range[0].as_u64().unwrap() as usize,
                    range[1].as_u64().unwrap() as usize,
                )
            })
            .collect::<Vec<_>>();
        let mut document =
            SyntaxDocument::open(language, DocumentRevision::new(1), source).unwrap();
        for revision in 1..=3 {
            let folds = document.editor_facts_snapshot(4, &|| false).unwrap().1;
            let regions = folds
                .iter()
                .filter(|fold| fold.kind == Some("region"))
                .map(|fold| (fold.start_line_index, fold.end_line_index))
                .collect::<Vec<_>>();
            let shift = usize::from(revision == 2);
            assert_eq!(
                regions,
                expected
                    .iter()
                    .map(|(start, end)| (start + shift, end + shift))
                    .collect::<Vec<_>>(),
                "{id} revision {revision}"
            );
            if let Some(range) = fixture["indentFold"].as_array() {
                let start = range[0].as_u64().unwrap() as usize + shift;
                let end = range[1].as_u64().unwrap() as usize + shift;
                assert!(
                    folds
                        .iter()
                        .any(|fold| fold.start_line_index == start && fold.end_line_index == end),
                    "{id}: missing {start}..{end}; got {folds:?}"
                );
            }
            match revision {
                1 => {
                    document
                        .update_edits(DocumentRevision::new(2), &[SyntaxEdit::insert(0, "\n")])
                        .unwrap();
                }
                2 => {
                    document
                        .update_edits(DocumentRevision::new(3), &[SyntaxEdit::replace(0..1, "")])
                        .unwrap();
                }
                _ => (),
            }
        }
    }
}

#[test]
fn cached_editor_facts_match_fresh_trees_across_batched_edits_and_recovery() {
    for (language, text) in [
        (
            SyntaxLanguage::Javascript,
            "// #region API\r\nexport function café() {\r\n  return '😀';\r\n}\r\nfunction tail() {\r\n  return 2;\r\n}\r\n// #endregion\r\n",
        ),
        (
            SyntaxLanguage::Typescript,
            "// #region API\nexport class Café {\n\trun(): string { return '😀'; }\n}\ninterface Tail {\n  value: number;\n}\n// #endregion\n",
        ),
        (
            SyntaxLanguage::Rust,
            "// #region API\npub fn café() -> &'static str {\n  \"😀\"\n}\nimpl Tail {\n  fn run() {}\n}\n// #endregion\n",
        ),
    ] {
        let mut document = SyntaxDocument::open(language, DocumentRevision::new(1), text).unwrap();
        for revision in 1..=12 {
            for tab_size in [4, 2] {
                let cached = document.editor_facts_snapshot(tab_size, &|| false).unwrap();
                let fresh = SyntaxDocument::open(
                    language,
                    document.revision(),
                    document.text().to_string(),
                )
                .unwrap();
                assert_eq!(
                    cached,
                    fresh.editor_facts_snapshot(tab_size, &|| false).unwrap(),
                    "{language:?} revision {revision}"
                );
                assert_eq!(
                    cached.0.symbols(),
                    fresh.snapshot().symbols(),
                    "subtree queries preserve whole-tree symbols"
                );
                assert_eq!(cached.0.diagnostics(), fresh.snapshot().diagnostics());
            }
            if revision == 12 {
                break;
            }
            let edits = match revision {
                1 => vec![SyntaxEdit::insert(0, "// leading 😀\n")],
                2 => vec![SyntaxEdit::insert(
                    document
                        .text()
                        .to_string()
                        .find("café")
                        .or_else(|| document.text().to_string().find("Café"))
                        .unwrap()
                        + 5,
                    "新",
                )],
                3 => vec![SyntaxEdit::insert(
                    document.text().to_string().find('{').unwrap() + 1,
                    "\n  // multiline\n",
                )],
                4 => vec![SyntaxEdit::delete(
                    0..document.text().to_string().find('\n').unwrap() + 1,
                )],
                5 => vec![SyntaxEdit::replace(
                    0..document.text().to_string().find('\n').unwrap(),
                    "// ordinary",
                )],
                6 => vec![SyntaxEdit::insert(
                    document.text().to_string().find('}').unwrap(),
                    "{",
                )],
                7 => {
                    let offset = document.text().to_string().find('{').unwrap();
                    vec![SyntaxEdit::delete(offset..offset + 1)]
                }
                8 => vec![
                    SyntaxEdit::insert(0, "\n"),
                    SyntaxEdit::insert(document.text().len_bytes(), "// trailing\n"),
                ],
                9 => vec![SyntaxEdit::replace(
                    0..document.text().len_bytes(),
                    text.replace("\r\n", "\n"),
                )],
                10 => vec![
                    SyntaxEdit::insert(document.text().to_string().find('{').unwrap(), "\n"),
                    SyntaxEdit::insert(0, "// top\n"),
                ],
                _ => vec![SyntaxEdit::replace(0..document.text().len_bytes(), "")],
            };
            document
                .update_edits(DocumentRevision::new(revision + 1), &edits)
                .unwrap();
        }
    }
}

#[test]
fn rope_edits_preserve_old_snapshots_and_share_untouched_text() {
    let source = "const value = 1;\n".repeat(100_000);
    let mut document = SyntaxDocument::open(
        SyntaxLanguage::Javascript,
        DocumentRevision::new(1),
        &source,
    )
    .unwrap();
    let old = ropey::Rope::from(document.text());
    let far = source.len() / 2;
    let old_chunk = old.chunk_at_byte(far).0.as_ptr();
    document
        .update_edits(
            DocumentRevision::new(2),
            &[SyntaxEdit::insert(0, "// 😀\n")],
        )
        .unwrap();
    assert_eq!(old, source);
    assert_eq!(document.text().byte_slice(.."// 😀\n".len()), "// 😀\n");
    assert_eq!(
        document
            .text()
            .chunk_at_byte(far + "// 😀\n".len())
            .0
            .as_ptr(),
        old_chunk
    );
    let revision = document.revision();
    let unchanged = ropey::Rope::from(document.text());
    assert!(
        document
            .update_edits(
                DocumentRevision::new(3),
                &[SyntaxEdit::insert(4, "invalid")]
            )
            .is_err()
    );
    assert_eq!(document.revision(), revision);
    assert_eq!(document.text(), unchanged);
}

#[test]
fn rope_queries_keep_symbols_and_utf16_coordinates_across_chunks_and_mixed_separators() {
    let name = "Café".repeat(600);
    let source = format!(
        "// 😀\r\nfunction {name}() {{\r\n  const value = \"中文😀\\u2028\";\r\n}}\r\n// lone\rseparator\u{2028}stay\n"
    );
    let mut document = SyntaxDocument::open(
        SyntaxLanguage::Javascript,
        DocumentRevision::new(1),
        &source,
    )
    .unwrap();
    let snapshot = document.snapshot();
    assert_eq!(
        document.line_count(),
        source.bytes().filter(|b| *b == b'\n').count() + 1
    );
    assert!(snapshot.symbols().iter().any(|symbol| symbol.name == name));
    let expected = document
        .editor_highlight(0..document.line_count(), &|| false)
        .unwrap();
    assert!(!expected[2].tokens.is_empty());
    let byte = source.find("中文").unwrap();
    let point = crate::SyntaxPoint {
        row: 2,
        column: byte + "中文😀".len() - document.text().line_to_byte(2),
    };
    assert_eq!(
        document.utf16_column(point),
        "  const value = \"中文😀".encode_utf16().count()
    );
    let frozen = ropey::Rope::from(document.text());
    let edit = SyntaxEdit::replace(byte..byte + "中文😀".len(), "新😀\r\n行");
    document
        .update_edits(DocumentRevision::new(2), &[edit])
        .unwrap();
    let fresh = SyntaxDocument::open(
        SyntaxLanguage::Javascript,
        document.revision(),
        document.text().to_string(),
    )
    .unwrap();
    assert_eq!(document.snapshot(), fresh.snapshot());
    assert_eq!(
        document
            .editor_highlight(0..document.line_count(), &|| false)
            .unwrap(),
        fresh
            .editor_highlight(0..fresh.line_count(), &|| false)
            .unwrap()
    );
    assert_eq!(frozen, source);
    let revision = document.revision();
    let preview = document
        .editor_preview(2, &["  const value = \"preview😀\";".into()], &|| false)
        .unwrap();
    assert!(!preview[0].tokens.is_empty());
    assert_eq!(document.revision(), revision);
    assert_eq!(document.snapshot(), fresh.snapshot());
}

trait EditorFactsSnapshot {
    fn editor_facts_snapshot(
        &self,
        tab_size: usize,
        cancelled: &impl Fn() -> bool,
    ) -> Result<(crate::SyntaxSnapshot, Vec<crate::EditorFold>), SyntaxError>;
}
impl EditorFactsSnapshot for SyntaxDocument {
    fn editor_facts_snapshot(
        &self,
        tab_size: usize,
        cancelled: &impl Fn() -> bool,
    ) -> Result<(crate::SyntaxSnapshot, Vec<crate::EditorFold>), SyntaxError> {
        editor_facts_snapshot(self, tab_size, cancelled)
    }
}
// Expand the editor's UTF-16 facts back to byte coordinates for comparison with
// the independent whole-tree snapshot and the folding oracle below.
fn editor_facts_snapshot(
    document: &SyntaxDocument,
    tab_size: usize,
    cancelled: &impl Fn() -> bool,
) -> Result<(crate::SyntaxSnapshot, Vec<crate::EditorFold>), SyntaxError> {
    let facts = document.editor_facts(tab_size, cancelled)?;
    let delta = facts.delta(None, &[]);
    let range = |range: [usize; 4]| {
        let point = |row, column| {
            let line = document.text().line(row);
            let offset = document.text().line_to_byte(row)
                + line.char_to_byte(line.utf16_cu_to_char(column));
            (
                offset,
                crate::SyntaxPoint {
                    row,
                    column: offset - document.text().line_to_byte(row),
                },
            )
        };
        let (start, start_point) = point(range[0], range[1]);
        let (end, end_point) = point(range[2], range[3]);
        crate::SyntaxRange {
            bytes: start..end,
            start: start_point,
            end: end_point,
        }
    };
    Ok((
        crate::SyntaxSnapshot::new(
            document.revision(),
            document.snapshot().has_errors(),
            Vec::new(),
            Vec::new(),
            delta
                .symbols
                .items
                .into_iter()
                .map(|symbol| crate::DocumentSymbol {
                    name: symbol.name,
                    kind: symbol.kind,
                    range: range(symbol.range),
                    selection_range: range(symbol.selection_range),
                })
                .collect(),
            delta
                .diagnostics
                .items
                .into_iter()
                .map(|diagnostic| crate::SyntaxDiagnostic {
                    range: range(diagnostic.range),
                    kind: diagnostic.kind,
                })
                .collect(),
        ),
        delta.folds.items,
    ))
}

#[test]
fn hundred_thousand_line_edits_reuse_subtree_coordinates_and_line_folds() {
    use std::cell::Cell;
    let text=(0..16_666).map(|index| format!("function item{index}() {{\n  const value = '😀';\n  if (value) {{\n    return value;\n  }}\n}}\n")).collect::<String>() + &"// padding\n".repeat(3);
    let mut document =
        SyntaxDocument::open(SyntaxLanguage::Javascript, DocumentRevision::new(1), &text).unwrap();
    assert_eq!(document.line_count(), 100_000);
    let mut facts = document.editor_facts(4, &|| false).unwrap();
    let mut revision = 1;
    for index in [0, 8_333, 16_665] {
        let offset = document
            .text()
            .to_string()
            .find(&format!("item{index}"))
            .unwrap()
            + format!("item{index}").len();
        revision += 1;
        document
            .update_edits(
                DocumentRevision::new(revision),
                &[SyntaxEdit::insert(offset, "新")],
            )
            .unwrap();
        let calls = Cell::new(0);
        let current = document
            .editor_facts(4, &|| {
                calls.set(calls.get() + 1);
                false
            })
            .unwrap();
        assert!(
            calls.get() < 256,
            "a name edit must not visit every line: {}",
            calls.get()
        );
        let patch = current.delta(
            Some(&facts),
            &[[
                index * 6,
                8 + index.to_string().len(),
                index * 6,
                8 + index.to_string().len(),
                index * 6,
                9 + index.to_string().len(),
            ]],
        );
        assert!(patch.symbols.items.len() <= 3);
        assert_eq!(patch.symbols.delete_count, patch.symbols.items.len());
        assert_eq!(patch.symbols.items[0].name, format!("item{index}新"));
        assert!(patch.folds.items.is_empty());
        assert_eq!(patch.folds.delete_count, 0);
        assert!(patch.diagnostics.items.is_empty());
        facts = current;
    }
    // Checkpoint convergence also bounds a newline edit near the file's start.
    revision += 1;
    document
        .update_edits(
            DocumentRevision::new(revision),
            &[SyntaxEdit::insert(0, "// 😀\r\n")],
        )
        .unwrap();
    let calls = Cell::new(0);
    let current = document
        .editor_facts(4, &|| {
            calls.set(calls.get() + 1);
            false
        })
        .unwrap();
    assert!(
        calls.get() < 400,
        "newline scans should stop at a matching checkpoint: {}",
        calls.get()
    );
    let fresh = SyntaxDocument::open(
        SyntaxLanguage::Javascript,
        document.revision(),
        document.text().to_string(),
    )
    .unwrap();
    let current = current.delta(None, &[]);
    let fresh = fresh.editor_facts(4, &|| false).unwrap().delta(None, &[]);
    assert_eq!(current.symbols.items, fresh.symbols.items);
    assert_eq!(current.folds.items, fresh.folds.items);
}

#[test]
fn incremental_line_folding_matches_fresh_after_regions_indents_and_deletions() {
    let text=(0..256).map(|index| format!("// #region part{index}\nfunction item{index}() {{\n\tif (true) {{\n\t  return '😀';\n\t}}\n}}\n// #endregion\n\n")).collect::<String>();
    let mut document =
        SyntaxDocument::open(SyntaxLanguage::Javascript, DocumentRevision::new(1), text).unwrap();
    document.editor_facts(4, &|| false).unwrap();
    let mut seed = 19_u64;
    for revision in 2..102 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let mut row = (seed as usize) % document.line_count();
        while !document
            .text()
            .line(row)
            .to_string()
            .trim()
            .starts_with("//")
            && !document.text().line(row).to_string().trim().is_empty()
        {
            row = (row + 1) % document.line_count();
        }
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
        let cancelled = std::cell::Cell::new(0);
        if revision % 5 == 0 {
            let _ = document.editor_facts(4, &|| {
                cancelled.set(cancelled.get() + 1);
                cancelled.get() > 3
            });
        }
        let tab_size = 4;
        {
            let current = document
                .editor_facts(tab_size, &|| false)
                .unwrap()
                .delta(None, &[]);
            let fresh = SyntaxDocument::open(
                SyntaxLanguage::Javascript,
                document.revision(),
                document.text().to_string(),
            )
            .unwrap();
            assert_eq!(
                document.snapshot().symbols(),
                fresh.snapshot().symbols(),
                "parser parity revision {revision}"
            );
            let fresh = fresh
                .editor_facts(tab_size, &|| false)
                .unwrap()
                .delta(None, &[]);
            assert_eq!(
                current.symbols.items, fresh.symbols.items,
                "symbols revision {revision}"
            );
            assert_eq!(
                current.folds.items, fresh.folds.items,
                "folds revision {revision}"
            );
            assert_eq!(
                current.diagnostics.items, fresh.diagnostics.items,
                "diagnostics revision {revision}"
            );
        }
    }
}

#[test]
fn python_queries_keep_incremental_highlights_and_symbols() {
    let text = "@decorator\ndef greet(name):\n    return \"你好🙂\"\n";
    let mut document =
        SyntaxDocument::open(SyntaxLanguage::Python, DocumentRevision::new(1), text).unwrap();
    let rows = document.editor_highlight(0..3, &|| false).unwrap();
    assert!(rows[1].tokens.iter().any(|token| token.name == "keyword"));
    assert!(
        document
            .snapshot()
            .symbols()
            .iter()
            .any(|symbol| symbol.name == "greet")
    );
    let at = text.find("你好").unwrap();
    document
        .update_edits(
            DocumentRevision::new(2),
            &[SyntaxEdit::replace(at..at, "updated ")],
        )
        .unwrap();
    let fresh = SyntaxDocument::open(
        SyntaxLanguage::Python,
        DocumentRevision::new(2),
        &text.replace("你好", "updated 你好"),
    )
    .unwrap();
    assert_eq!(
        document.editor_highlight(0..3, &|| false).unwrap(),
        fresh.editor_highlight(0..3, &|| false).unwrap()
    );
}

#[test]
fn coffeescript_parses_the_official_compiler_validated_corpus() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/tree-sitter/coffeescript.json"
    ))
    .unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 41);
    for case in cases {
        let document = SyntaxDocument::open(
            SyntaxLanguage::Coffeescript,
            DocumentRevision::new(1),
            case["source"].as_str().unwrap(),
        )
        .unwrap();
        assert!(!document.snapshot().has_errors(), "{}", case["name"]);
    }
}

#[test]
fn bundled_languages_parse_and_highlight_expected_lexemes() {
    let samples: Vec<serde_json::Value> = serde_json::from_str(include_str!(
        "../../../test/fixtures/tree-sitter/languages.json"
    ))
    .unwrap();
    for sample in samples {
        let id = sample["language"].as_str().unwrap();
        let language = crate::language::SyntaxLanguage::for_injection(id).unwrap();
        let text = sample["text"].as_str().unwrap();
        let document = SyntaxDocument::open(language, DocumentRevision::new(1), text).unwrap();
        assert!(
            !document.snapshot().has_errors(),
            "{id}: valid sample must parse"
        );
        let rows = document
            .editor_highlight(0..document.line_count(), &|| false)
            .unwrap();
        let lexeme = sample["lexeme"].as_str().unwrap();
        assert!(
            rows.iter().any(|row| row.tokens.iter().any(|token| {
                let line: String = text
                    .lines()
                    .nth(row.row)
                    .unwrap_or("")
                    .encode_utf16()
                    .skip(token.start)
                    .take(token.end - token.start)
                    .map(|c| char::from_u32(u32::from(c)).unwrap_or('�'))
                    .collect();
                line.contains(lexeme) && token.name.starts_with(sample["capture"].as_str().unwrap())
            })),
            "{id}: missing {lexeme} in {rows:?}"
        );
    }
}

#[test]
fn embedded_html_markdown_and_diff_keep_global_coordinates_after_edits() {
    for (language, text, lexeme, capture) in [
        (
            SyntaxLanguage::Html,
            "<script>const value = '你好🙂';</script>\n<style>body { color: red; }</style>",
            "const",
            "keyword",
        ),
        (
            SyntaxLanguage::Html,
            "<script type=\"application/json\">{\"value\": 42}</script>",
            "42",
            "number",
        ),
        (
            SyntaxLanguage::Markdown,
            "# Title\n\n```python\ndef greet():\n    return '你好🙂'\n```\n",
            "def",
            "keyword",
        ),
        (
            SyntaxLanguage::Markdown,
            "Some **strong text**.\n",
            "strong text",
            "text.strong",
        ),
        (
            SyntaxLanguage::Diff,
            "diff --git a/main.js b/main.js\n--- a/main.js\n+++ b/main.js\n@@ -1 +1 @@\n-const old = 1;\n+const value = 2;\n",
            "const",
            "keyword",
        ),
    ] {
        let mut document = SyntaxDocument::open(language, DocumentRevision::new(1), text).unwrap();
        let rows = document
            .editor_highlight(0..document.line_count(), &|| false)
            .unwrap();
        assert!(
            rows.iter().any(|row| row.tokens.iter().any(|token| {
                let units = text
                    .lines()
                    .nth(row.row)
                    .unwrap_or("")
                    .encode_utf16()
                    .skip(token.start)
                    .take(token.end - token.start)
                    .collect::<Vec<_>>();
                String::from_utf16_lossy(&units).contains(lexeme) && token.name.starts_with(capture)
            })),
            "{language:?}: missing embedded {lexeme} in {rows:?}"
        );
        document
            .update_edits(DocumentRevision::new(2), &[SyntaxEdit::replace(0..0, "\n")])
            .unwrap();
        let fresh =
            SyntaxDocument::open(language, DocumentRevision::new(2), format!("\n{text}")).unwrap();
        assert_eq!(
            document
                .editor_highlight(0..document.line_count(), &|| false)
                .unwrap(),
            fresh
                .editor_highlight(0..fresh.line_count(), &|| false)
                .unwrap()
        );
    }
}

#[test]
fn embedded_language_identity_brackets_and_preview_use_the_same_coordinates() {
    let text = "<script>const value = { unknown };</script>";
    let document =
        SyntaxDocument::open(SyntaxLanguage::Html, DocumentRevision::new(1), text).unwrap();
    let rows = document.editor_highlight(0..1, &|| false).unwrap();
    let unknown = text.find("unknown").unwrap();
    assert!(rows[0].tokens.iter().any(|token| token.start <= unknown
        && token.end > unknown
        && token.language_id == Some("javascript")));
    let brackets = document.editor_brackets(&[0..1], 4, &|| false).unwrap();
    assert!(
        brackets
            .iter()
            .any(|pair| pair.text == "{" && pair.close_text.as_deref() == Some("}"))
    );
    let preview = document
        .editor_preview(
            0,
            &["<script>const value = 'changed';</script>".into()],
            &|| false,
        )
        .unwrap();
    assert!(
        preview[0]
            .tokens
            .iter()
            .any(|token| token.name == "string" && token.language_id == Some("javascript"))
    );
    assert_eq!(document.editor_highlight(0..1, &|| false).unwrap(), rows);
}

#[test]
fn embedded_multiline_capture_does_not_cover_diff_markers() {
    let text = "diff --git a/main.js b/main.js\n--- a/main.js\n+++ b/main.js\n@@ -1,2 +1,2 @@\n-const old = `one\n-two`;\n+const value = `three\n+four`;\n";
    let document =
        SyntaxDocument::open(SyntaxLanguage::Diff, DocumentRevision::new(1), text).unwrap();
    let rows = document
        .editor_highlight(0..document.line_count(), &|| false)
        .unwrap();
    assert!(rows[7].tokens.iter().any(|token| token.start == 1
        && token.language_id == Some("javascript")
        && token.name.starts_with("string")));
    for row in &rows[4..8] {
        assert!(
            row.tokens
                .iter()
                .any(|token| token.start == 0 && token.end == 1 && token.language_id.is_none())
        );
    }
}

#[test]
fn language_package_structure_fixtures_survive_edits_and_undo() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/tree-sitter/structure.json"
    ))
    .unwrap();
    for fixture in fixtures.as_array().unwrap() {
        let id = fixture["language"].as_str().unwrap();
        let language = SyntaxLanguage::for_injection(id).unwrap();
        let text = fixture["text"].as_str().unwrap();
        let mut document = SyntaxDocument::open(language, DocumentRevision::new(1), text).unwrap();
        let original = document
            .editor_facts(4, &|| false)
            .unwrap()
            .delta(None, &[]);
        for name in fixture["symbols"].as_array().unwrap() {
            assert!(
                original
                    .symbols
                    .items
                    .iter()
                    .any(|symbol| symbol.name == name.as_str().unwrap()),
                "{id}: missing {name}; got {:?}",
                original.symbols.items
            );
        }
        for fold in fixture["folds"].as_array().unwrap() {
            let start = fold[0].as_u64().unwrap() as usize;
            let end = fold[1].as_u64().unwrap() as usize;
            assert!(
                original
                    .folds
                    .items
                    .iter()
                    .any(|fold| fold.start_line_index == start && fold.end_line_index == end),
                "{id}: missing {start}..{end}; got {:?}",
                original.folds.items
            );
        }
        if fixture["exactSymbols"].as_bool() == Some(true) {
            assert_eq!(
                original
                    .symbols
                    .items
                    .iter()
                    .map(|symbol| symbol.name.as_str())
                    .collect::<Vec<_>>(),
                fixture["symbols"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|name| name.as_str().unwrap())
                    .collect::<Vec<_>>(),
                "{id}"
            );
        }
        if fixture["noFolds"].as_bool() == Some(true) {
            assert!(original.folds.items.is_empty(), "{id}");
        }
        document
            .update_edits(DocumentRevision::new(2), &[SyntaxEdit::replace(0..0, "\n")])
            .unwrap();
        let shifted = document
            .editor_facts(4, &|| false)
            .unwrap()
            .delta(None, &[]);
        let fresh = SyntaxDocument::open(
            language,
            DocumentRevision::new(2),
            document.text().to_string(),
        )
        .unwrap()
        .editor_facts(4, &|| false)
        .unwrap()
        .delta(None, &[]);
        assert_eq!(shifted.symbols.items, fresh.symbols.items, "{id}");
        assert_eq!(shifted.folds.items, fresh.folds.items, "{id}");
        document
            .update_edits(DocumentRevision::new(3), &[SyntaxEdit::replace(0..1, "")])
            .unwrap();
        let restored = document
            .editor_facts(4, &|| false)
            .unwrap()
            .delta(None, &[]);
        assert_eq!(restored.symbols.items, original.symbols.items, "{id}");
        assert_eq!(restored.folds.items, original.folds.items, "{id}");
    }
}

#[test]
fn line_terminators_do_not_make_single_line_properties_foldable() {
    let document = SyntaxDocument::open(
        SyntaxLanguage::Properties,
        DocumentRevision::new(1),
        "one=value\ntwo=value\n",
    )
    .unwrap();
    assert!(document.snapshot().folding_ranges().is_empty());
    let document = SyntaxDocument::open(
        SyntaxLanguage::Properties,
        DocumentRevision::new(1),
        "one=value\\\n continued\ntwo=value\n",
    )
    .unwrap();
    assert_eq!(document.snapshot().folding_ranges().len(), 1);
}
