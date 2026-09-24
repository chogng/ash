use crate::CodeEditorCommand;
use crate::CodeEditorDocument;
use crate::CodeEditorPosition;
use crate::CodeEditorSelectionMode;

#[test]
fn duplicate_below_moves_a_caret_to_the_matching_column_in_the_copy() {
    let mut document = CodeEditorDocument::from_text("one\ntwo");
    let position = CodeEditorPosition {
        row_index: 0,
        byte_offset: 1,
    };
    document.set_selection(position, position);

    document.apply(CodeEditorCommand::DuplicateLinesBelow);
    document.apply(CodeEditorCommand::Insert("X".to_owned()));

    assert_eq!(document.text(), "one\noXne\ntwo");
}

#[test]
fn duplicate_above_preserves_crlf_and_excludes_an_unselected_boundary_line() {
    let mut document = CodeEditorDocument::from_text("one\r\ntwo\r\nthree");
    document.set_selection(
        CodeEditorPosition {
            row_index: 1,
            byte_offset: 0,
        },
        CodeEditorPosition {
            row_index: 2,
            byte_offset: 0,
        },
    );

    document.apply(CodeEditorCommand::DuplicateLinesAbove);
    assert_eq!(document.text(), "one\r\ntwo\r\ntwo\r\nthree");
    assert_eq!(document.selected_text(), Some("two\r\n"));
    document.apply(CodeEditorCommand::Undo);
    assert_eq!(document.text(), "one\r\ntwo\r\nthree");
}

#[test]
fn duplicate_last_line_without_a_terminator_inserts_a_separator() {
    let mut document = CodeEditorDocument::from_text("last");
    document.apply(CodeEditorCommand::MoveToLineEnd(
        CodeEditorSelectionMode::Move,
    ));

    document.apply(CodeEditorCommand::DuplicateLinesBelow);
    document.apply(CodeEditorCommand::Insert("!".to_owned()));

    assert_eq!(document.text(), "last\nlast!");
}

#[test]
fn move_up_swaps_a_selected_crlf_block_without_including_its_boundary_line() {
    let mut document = CodeEditorDocument::from_text("one\r\ntwo\r\nthree\r\nfour");
    document.set_selection(
        CodeEditorPosition {
            row_index: 1,
            byte_offset: 0,
        },
        CodeEditorPosition {
            row_index: 3,
            byte_offset: 0,
        },
    );

    document.apply(CodeEditorCommand::MoveLinesUp);
    assert_eq!(document.text(), "two\r\nthree\r\none\r\nfour");
    assert_eq!(document.selected_text(), Some("two\r\nthree\r\n"));
    document.apply(CodeEditorCommand::Undo);
    assert_eq!(document.text(), "one\r\ntwo\r\nthree\r\nfour");
}

#[test]
fn move_down_keeps_a_collapsed_caret_in_the_matching_column() {
    let mut document = CodeEditorDocument::from_text("one\r\ntwo\r\nthree");
    let position = CodeEditorPosition {
        row_index: 1,
        byte_offset: 1,
    };
    document.set_selection(position, position);

    document.apply(CodeEditorCommand::MoveLinesDown);
    document.apply(CodeEditorCommand::Insert("X".to_owned()));

    assert_eq!(document.text(), "one\r\nthree\r\ntXwo");
}

#[test]
fn delete_last_selected_line_removes_its_preceding_crlf() {
    let mut document = CodeEditorDocument::from_text("one\r\ntwo\r\nthree");
    let position = CodeEditorPosition {
        row_index: 2,
        byte_offset: 0,
    };
    document.set_selection(position, position);

    document.apply(CodeEditorCommand::DeleteLines);

    assert_eq!(document.text(), "one\r\ntwo");
    document.apply(CodeEditorCommand::Undo);
    assert_eq!(document.text(), "one\r\ntwo\r\nthree");
}

#[test]
fn delete_multiple_selected_lines_preserves_the_unselected_boundary_line() {
    let mut document = CodeEditorDocument::from_text("one\ntwo\nthree\nfour");
    document.set_selection(
        CodeEditorPosition {
            row_index: 1,
            byte_offset: 0,
        },
        CodeEditorPosition {
            row_index: 3,
            byte_offset: 0,
        },
    );

    document.apply(CodeEditorCommand::DeleteLines);

    assert_eq!(document.text(), "one\nfour");
}

#[test]
fn join_lines_removes_only_line_endings_and_maps_the_caret() {
    let mut document = CodeEditorDocument::from_text("one\r\n  two\r\nthree");
    let position = CodeEditorPosition {
        row_index: 1,
        byte_offset: 3,
    };
    document.set_selection(position, position);

    document.apply(CodeEditorCommand::JoinLines);
    document.apply(CodeEditorCommand::Insert("X".to_owned()));

    assert_eq!(document.text(), "one\r\n  tXwothree");
}

#[test]
fn join_selected_lines_excludes_the_unselected_boundary_line() {
    let mut document = CodeEditorDocument::from_text("one\ntwo\nthree");
    document.set_selection(
        CodeEditorPosition {
            row_index: 0,
            byte_offset: 0,
        },
        CodeEditorPosition {
            row_index: 2,
            byte_offset: 0,
        },
    );

    document.apply(CodeEditorCommand::JoinLines);

    assert_eq!(document.text(), "onetwo\nthree");
}

#[test]
fn join_all_lines_includes_a_final_empty_line() {
    let mut document = CodeEditorDocument::from_text("one\n");
    document.apply(CodeEditorCommand::SelectAll);

    document.apply(CodeEditorCommand::JoinLines);

    assert_eq!(document.text(), "one");
}

#[test]
fn delete_empty_selected_lines_preserves_nonempty_and_final_line_boundaries() {
    let mut document = CodeEditorDocument::from_text("one\r\n\r\ntwo\r\n\r\n");
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

    document.apply(CodeEditorCommand::DeleteEmptyLines);

    assert_eq!(document.text(), "one\r\ntwo");
    document.apply(CodeEditorCommand::Undo);
    assert_eq!(document.text(), "one\r\n\r\ntwo\r\n\r\n");
}

#[test]
fn insert_adjacent_lines_preserves_crlf_and_places_the_caret_in_the_new_line() {
    let mut document = CodeEditorDocument::from_text("one\r\ntwo");
    let position = CodeEditorPosition {
        row_index: 1,
        byte_offset: 1,
    };
    document.set_selection(position, position);

    document.apply(CodeEditorCommand::InsertLineAbove);
    document.apply(CodeEditorCommand::Insert("X".to_owned()));
    assert_eq!(document.text(), "one\r\nX\r\ntwo");

    document.apply(CodeEditorCommand::InsertLineBelow);
    document.apply(CodeEditorCommand::Insert("Y".to_owned()));
    assert_eq!(document.text(), "one\r\nX\r\nY\r\ntwo");
}

#[test]
fn insert_line_below_a_final_line_without_a_terminator_creates_a_blank_following_line() {
    let mut document = CodeEditorDocument::from_text("last");

    document.apply(CodeEditorCommand::InsertLineBelow);
    document.apply(CodeEditorCommand::Insert("next".to_owned()));

    assert_eq!(document.text(), "last\nnext");
}

#[test]
fn trim_trailing_whitespace_preserves_crlf_and_maps_a_caret_at_line_end() {
    let mut document = CodeEditorDocument::from_text("one  \r\ntwo\t \r\nthree ");
    let position = CodeEditorPosition {
        row_index: 1,
        byte_offset: 5,
    };
    document.set_selection(position, position);

    document.apply(CodeEditorCommand::TrimTrailingWhitespace);
    document.apply(CodeEditorCommand::Insert("X".to_owned()));

    assert_eq!(document.text(), "one\r\ntwoX\r\nthree");
    document.apply(CodeEditorCommand::Undo);
    assert_eq!(document.text(), "one\r\ntwo\r\nthree");
}

#[test]
fn sort_selected_lines_is_stable_preserves_crlf_and_retains_the_full_line_selection() {
    let mut document = CodeEditorDocument::from_text("prefix\r\nzulu\r\nAlpha\r\nzulu\r\nsuffix");
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

    document.apply(CodeEditorCommand::SortLinesAscending);

    assert_eq!(document.text(), "prefix\r\nAlpha\r\nzulu\r\nzulu\r\nsuffix");
    assert_eq!(document.selected_text(), Some("Alpha\r\nzulu\r\nzulu\r\n"));
}

#[test]
fn sort_selected_lines_supports_descending_order() {
    let mut document = CodeEditorDocument::from_text("a\nc\nb");
    document.set_selection(
        CodeEditorPosition {
            row_index: 0,
            byte_offset: 0,
        },
        CodeEditorPosition {
            row_index: 2,
            byte_offset: 1,
        },
    );

    document.apply(CodeEditorCommand::SortLinesDescending);

    assert_eq!(document.text(), "c\nb\na");
}
