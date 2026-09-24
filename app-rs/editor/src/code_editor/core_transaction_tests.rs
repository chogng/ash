use super::CodeEditorCoreTransactionError;
use crate::CodeEditorCommand;
use crate::CodeEditorDocument;
use ash_editor_core::EditorCoreRevision;
use ash_editor_core::EditorCoreSelection;
use ash_editor_core::EditorCoreSelectionSet;
use ash_editor_core::EditorCoreTextEdit;
use ash_editor_core::EditorCoreTextRange;
use ash_editor_core::EditorCoreTransaction;
use ash_editor_core::EditorCoreUtf16Offset;

fn selection(offset: u32) -> EditorCoreSelectionSet {
    EditorCoreSelectionSet::single(EditorCoreSelection::collapsed_at(
        EditorCoreUtf16Offset::new(offset),
    ))
}

#[test]
fn shared_transactions_update_native_text_history_and_utf16_selection() {
    let mut document = CodeEditorDocument::from_text("a😀b");
    let transaction = EditorCoreTransaction::new(
        EditorCoreRevision::INITIAL,
        vec![EditorCoreTextEdit::new(
            EditorCoreTextRange::new(EditorCoreUtf16Offset::new(1), EditorCoreUtf16Offset::new(3))
                .unwrap(),
            "X",
        )],
        selection(2),
    );

    document.apply_core_transaction(transaction).unwrap();
    assert_eq!(document.text(), "aXb");
    assert_eq!(document.cursor(), 2);
    assert_eq!(document.revision().value(), 2);

    document.apply(CodeEditorCommand::Undo);
    assert_eq!(document.text(), "a😀b");
    document.apply(CodeEditorCommand::Redo);
    assert_eq!(document.text(), "aXb");
}

#[test]
fn native_rejects_multi_selection_core_transactions_without_mutation() {
    let mut document = CodeEditorDocument::from_text("one");
    let transaction = EditorCoreTransaction::new(
        EditorCoreRevision::INITIAL,
        Vec::new(),
        EditorCoreSelectionSet::new(
            vec![
                EditorCoreSelection::collapsed_at(EditorCoreUtf16Offset::ZERO),
                EditorCoreSelection::collapsed_at(EditorCoreUtf16Offset::new(1)),
            ],
            0,
        )
        .unwrap(),
    );

    assert_eq!(
        document.apply_core_transaction(transaction),
        Err(CodeEditorCoreTransactionError::MultipleSelectionsUnsupported)
    );
    assert_eq!(document.text(), "one");
    assert_eq!(document.revision(), EditorCoreRevision::INITIAL);
}
