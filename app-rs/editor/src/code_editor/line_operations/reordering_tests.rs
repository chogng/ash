use crate::CodeEditorCommand;
use crate::CodeEditorDocument;
use crate::CodeEditorPosition;

#[test]
fn reverse_selected_lines_preserves_crlf_and_retains_the_full_line_selection() {
    let mut document = CodeEditorDocument::from_text("prefix\r\none\r\ntwo\r\nthree\r\nsuffix");
    document.set_selection(
        CodeEditorPosition {
            row_index: 1,
            byte_offset: 0,
        },
        CodeEditorPosition {
            row_index: 4,
            byte_offset: 0,
        },
    );

    document.apply(CodeEditorCommand::ReverseSelectedLines);

    assert_eq!(document.text(), "prefix\r\nthree\r\ntwo\r\none\r\nsuffix");
    assert_eq!(document.selected_text(), Some("three\r\ntwo\r\none\r\n"));
}

#[test]
fn remove_duplicate_selected_lines_keeps_first_occurrences_and_the_boundary_ending() {
    let mut document = CodeEditorDocument::from_text("prefix\nalpha\nbeta\nalpha\nbeta\nsuffix");
    document.set_selection(
        CodeEditorPosition {
            row_index: 1,
            byte_offset: 0,
        },
        CodeEditorPosition {
            row_index: 5,
            byte_offset: 0,
        },
    );

    document.apply(CodeEditorCommand::RemoveDuplicateLines);

    assert_eq!(document.text(), "prefix\nalpha\nbeta\nsuffix");
    assert_eq!(document.selected_text(), Some("alpha\nbeta\n"));
}
