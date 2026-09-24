use ash_diff::DiffDocument;

use super::*;
use crate::CodeEditorFoldState;

#[test]
fn document_owns_language_and_both_syntax_snapshots() {
    let diff = DiffDocument::from_text(
        "fn before() { println!(\"old\"); }\n",
        "fn after() { println!(\"new\"); }\n",
    )
    .unwrap();
    let mut document = DiffEditorDocument::new(diff, CodeEditorLanguage::Rust);

    assert_eq!(document.language(), CodeEditorLanguage::Rust);
    assert!(
        !document
            .syntax_tokens(DiffEditorSide::Original, 1)
            .is_empty()
    );
    assert!(
        !document
            .syntax_tokens(DiffEditorSide::Modified, 1)
            .is_empty()
    );

    document.set_language(CodeEditorLanguage::PlainText);
    assert!(
        document
            .syntax_tokens(DiffEditorSide::Original, 1)
            .is_empty()
    );
    assert!(
        document
            .syntax_tokens(DiffEditorSide::Modified, 1)
            .is_empty()
    );
}

#[test]
fn syntax_fold_state_is_independent_between_diff_sources() {
    let diff = DiffDocument::from_text("{\n  \"value\": 1\n}\n", "{\n  \"value\": 2\n}\n").unwrap();
    let mut document = DiffEditorDocument::new(diff, CodeEditorLanguage::Json);

    assert_eq!(
        document.original.fold_state(0),
        Some(CodeEditorFoldState::Expanded)
    );
    assert_eq!(
        document.modified.fold_state(0),
        Some(CodeEditorFoldState::Expanded)
    );

    document
        .original
        .set_fold_state(0, CodeEditorFoldState::Collapsed);

    assert_eq!(
        document.original.fold_state(0),
        Some(CodeEditorFoldState::Collapsed)
    );
    assert_eq!(
        document.modified.fold_state(0),
        Some(CodeEditorFoldState::Expanded)
    );
}
