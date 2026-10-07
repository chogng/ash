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
        .find("second")
        .expect("first edit should insert second");

    let snapshot = document
        .apply_edit(
            DocumentRevision::new(3),
            &SyntaxEdit::replace(second_start..second_start + 6, "done"),
        )
        .expect("following edit should use the updated line index");

    assert_eq!(
        document.text(),
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
    let first = document.text().find("first").unwrap();
    let second = document.text().find("second").unwrap();

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
    let original = document.text().to_owned();
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
