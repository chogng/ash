use super::EditorCoreDocument;
use super::EditorCoreEditError;
use super::EditorCoreHistoryLimit;
use crate::EditorCoreHistoryMerge;
use crate::EditorCoreRevision;
use crate::EditorCoreSelection;
use crate::EditorCoreSelectionSet;
use crate::EditorCoreTextEdit;
use crate::EditorCoreTextRange;
use crate::EditorCoreTransaction;
use crate::EditorCoreUtf16Offset;

fn offset(value: u32) -> EditorCoreUtf16Offset {
    EditorCoreUtf16Offset::new(value)
}

fn range(start: u32, end: u32) -> EditorCoreTextRange {
    EditorCoreTextRange::new(offset(start), offset(end)).unwrap()
}

fn selections(at: u32) -> EditorCoreSelectionSet {
    EditorCoreSelectionSet::single(EditorCoreSelection::collapsed_at(offset(at)))
}

#[test]
fn transactions_apply_unordered_utf16_edits_atomically() {
    let mut document = EditorCoreDocument::new("a😀b");
    let snapshot = document
        .apply_transaction(EditorCoreTransaction::new(
            EditorCoreRevision::INITIAL,
            vec![
                EditorCoreTextEdit::new(range(3, 4), "B"),
                EditorCoreTextEdit::new(range(1, 3), "X"),
            ],
            selections(3),
        ))
        .unwrap();

    assert_eq!(snapshot.text(), "aXB");
    assert_eq!(snapshot.revision().value(), 2);
    assert_eq!(snapshot.selections().primary_index(), 0);
}

#[test]
fn transactions_reject_surrogate_offsets_and_leave_document_unchanged() {
    let mut document = EditorCoreDocument::new("a😀b");
    let result = document.apply_transaction(EditorCoreTransaction::new(
        EditorCoreRevision::INITIAL,
        vec![EditorCoreTextEdit::new(range(2, 3), "X")],
        selections(0),
    ));

    assert_eq!(result, Err(EditorCoreEditError::InvalidUtf16Offset));
    assert_eq!(document.text(), "a😀b");
    assert_eq!(document.revision(), EditorCoreRevision::INITIAL);
}

#[test]
fn stale_and_overlapping_transactions_never_mutate_document_state() {
    let mut document = EditorCoreDocument::new("alpha");
    let stale = document.apply_transaction(EditorCoreTransaction::new(
        EditorCoreRevision::default(),
        vec![EditorCoreTextEdit::new(range(0, 1), "A")],
        selections(1),
    ));
    assert_eq!(
        stale,
        Err(EditorCoreEditError::StaleRevision {
            expected: EditorCoreRevision::INITIAL,
            received: EditorCoreRevision::default(),
        })
    );
    let overlapping = document.apply_transaction(EditorCoreTransaction::new(
        EditorCoreRevision::INITIAL,
        vec![
            EditorCoreTextEdit::new(range(0, 2), "A"),
            EditorCoreTextEdit::new(range(1, 3), "B"),
        ],
        selections(0),
    ));
    assert_eq!(overlapping, Err(EditorCoreEditError::OverlappingEditRanges));
    assert_eq!(document.text(), "alpha");
}

#[test]
fn transport_deserialized_invalid_values_are_rejected_without_mutating_state() {
    let mut document = EditorCoreDocument::new("a");
    let invalid_range = serde_json::from_str(
        r#"{
            "baseRevision": "1",
            "edits": [{ "range": { "start": 1, "end": 0 }, "text": "b" }],
            "selections": { "selections": [{ "anchor": 0, "active": 0 }], "primaryIndex": 0 }
        }"#,
    )
    .unwrap();

    assert_eq!(
        document.apply_transaction(invalid_range),
        Err(EditorCoreEditError::InvalidTextRange)
    );
    assert_eq!(document.text(), "a");

    let invalid_selection = serde_json::from_str(
        r#"{
            "baseRevision": "1",
            "edits": [],
            "selections": { "selections": [], "primaryIndex": 0 }
        }"#,
    )
    .unwrap();

    assert_eq!(
        document.apply_transaction(invalid_selection),
        Err(EditorCoreEditError::InvalidSelection)
    );
    assert_eq!(document.text(), "a");
}

#[test]
fn undo_and_redo_restore_text_and_selection_as_new_revisions() {
    let mut document = EditorCoreDocument::with_history_limit("a", EditorCoreHistoryLimit::new(1));
    document
        .apply_transaction(EditorCoreTransaction::new(
            EditorCoreRevision::INITIAL,
            vec![EditorCoreTextEdit::new(range(1, 1), "b")],
            selections(2),
        ))
        .unwrap();

    let undone = document.undo().unwrap();
    assert_eq!(undone.text(), "a");
    assert_eq!(
        undone.selections().selections()[0],
        EditorCoreSelection::collapsed_at(offset(0))
    );
    let redone = document.redo().unwrap();
    assert_eq!(redone.text(), "ab");
    assert_eq!(
        redone.selections().selections()[0],
        EditorCoreSelection::collapsed_at(offset(2))
    );
    assert_eq!(redone.revision().value(), 4);
}

#[test]
fn merged_transactions_restore_the_original_state_in_one_undo_step() {
    let mut document = EditorCoreDocument::new("a");
    document
        .apply_transaction(EditorCoreTransaction::new(
            EditorCoreRevision::INITIAL,
            vec![EditorCoreTextEdit::new(range(1, 1), "b")],
            selections(2),
        ))
        .unwrap();
    document
        .apply_transaction_with_history(
            EditorCoreTransaction::new(
                EditorCoreRevision::parse_decimal("2").unwrap(),
                vec![EditorCoreTextEdit::new(range(2, 2), "c")],
                selections(3),
            ),
            EditorCoreHistoryMerge::MergeWithPrevious,
        )
        .unwrap();

    assert_eq!(document.text(), "abc");
    assert_eq!(document.undo().unwrap().text(), "a");
    assert!(document.undo().is_none());
}

#[test]
fn complete_replacement_clears_history_and_advances_revision() {
    let mut document = EditorCoreDocument::new("a");
    document
        .apply_transaction(EditorCoreTransaction::new(
            EditorCoreRevision::INITIAL,
            vec![EditorCoreTextEdit::new(range(1, 1), "b")],
            selections(2),
        ))
        .unwrap();

    let snapshot = document.replace_text("reload", selections(0)).unwrap();

    assert_eq!(snapshot.text(), "reload");
    assert_eq!(snapshot.revision().value(), 3);
    assert!(!document.can_undo());
    assert!(!document.can_redo());
}
