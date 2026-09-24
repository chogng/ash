use crate::CodeEditorCommand;
use crate::CodeEditorDocument;
use crate::CodeEditorTextEdit;
use ash_editor_core::EditorCoreDocument;
use ash_editor_core::EditorCoreRevision;
use ash_editor_core::EditorCoreSelection;
use ash_editor_core::EditorCoreSelectionSet;
use ash_editor_core::EditorCoreTextEdit;
use ash_editor_core::EditorCoreTextRange;
use ash_editor_core::EditorCoreTransaction;
use ash_editor_core::EditorCoreUtf16Offset;

fn utf16_offset(text: &str, byte_offset: usize) -> EditorCoreUtf16Offset {
    assert!(text.is_char_boundary(byte_offset));
    EditorCoreUtf16Offset::new(text[..byte_offset].encode_utf16().count() as u32)
}

fn selection(text: &str, byte_offset: usize) -> EditorCoreSelectionSet {
    EditorCoreSelectionSet::single(EditorCoreSelection::collapsed_at(utf16_offset(
        text,
        byte_offset,
    )))
}

#[test]
fn native_exact_edits_and_history_conform_to_the_shared_document_core() {
    let mut native = CodeEditorDocument::from_text("a😀b");
    let mut core = EditorCoreDocument::new("a😀b");

    assert!(native.apply_text_edit(CodeEditorTextEdit {
        range: 1..5,
        new_text: "X".into(),
    }));
    let snapshot = core
        .apply_transaction(EditorCoreTransaction::new(
            EditorCoreRevision::INITIAL,
            vec![EditorCoreTextEdit::new(
                EditorCoreTextRange::new(
                    EditorCoreUtf16Offset::new(1),
                    EditorCoreUtf16Offset::new(3),
                )
                .unwrap(),
                "X",
            )],
            selection("aXb", 2),
        ))
        .unwrap();

    assert_eq!(native.text(), snapshot.text());
    assert_eq!(native.revision().value(), snapshot.revision().value());
    assert_eq!(
        utf16_offset(native.text(), native.cursor()),
        snapshot.selections().selections()[0].active()
    );

    native.apply(CodeEditorCommand::Undo);
    let snapshot = core.undo().unwrap();
    assert_eq!(native.text(), snapshot.text());
    assert_eq!(native.revision().value(), snapshot.revision().value());

    native.apply(CodeEditorCommand::Redo);
    let snapshot = core.redo().unwrap();
    assert_eq!(native.text(), snapshot.text());
    assert_eq!(native.revision().value(), snapshot.revision().value());
}

#[test]
fn native_selection_moves_are_checkpointed_in_core_before_the_next_mutation() {
    let mut document = CodeEditorDocument::from_text("abc");

    document.apply(CodeEditorCommand::MoveRight(
        crate::CodeEditorSelectionMode::Move,
    ));
    document.apply(CodeEditorCommand::Insert("X".into()));
    document.apply(CodeEditorCommand::Undo);

    assert_eq!(document.text(), "abc");
    assert_eq!(document.cursor(), 1);
    assert_eq!(
        document.core.snapshot().selections().selections()[0].active(),
        EditorCoreUtf16Offset::new(1)
    );
}
