use crate::CodeEditorCommand;
use crate::CodeEditorDocument;
use crate::CodeEditorLanguage;
use crate::CodeEditorPosition;

#[test]
fn rust_line_comments_toggle_selected_lines_without_moving_their_indentation() {
    let mut document = CodeEditorDocument::from_text_with_language(
        "  let one = 1;\n\tlet two = 2;",
        CodeEditorLanguage::Rust,
    );
    document.set_selection(
        CodeEditorPosition {
            row_index: 0,
            byte_offset: 0,
        },
        CodeEditorPosition {
            row_index: 1,
            byte_offset: 12,
        },
    );

    document.apply(CodeEditorCommand::ToggleLineComment);
    assert_eq!(document.text(), "  // let one = 1;\n\t// let two = 2;");

    document.apply(CodeEditorCommand::ToggleLineComment);
    assert_eq!(document.text(), "  let one = 1;\n\tlet two = 2;");
}

#[test]
fn line_comment_commands_are_noops_for_json() {
    let mut document =
        CodeEditorDocument::from_text_with_language("{\"value\": 1}", CodeEditorLanguage::Json);

    document.apply(CodeEditorCommand::ToggleLineComment);

    assert_eq!(document.text(), "{\"value\": 1}");
    assert!(!document.can_undo());
}

#[test]
fn shell_line_comments_use_the_shell_marker() {
    let mut document =
        CodeEditorDocument::from_text_with_language("echo ready", CodeEditorLanguage::Shell);

    document.apply(CodeEditorCommand::ToggleLineComment);

    assert_eq!(document.text(), "# echo ready");
}
