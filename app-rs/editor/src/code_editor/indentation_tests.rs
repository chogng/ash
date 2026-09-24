use super::{CodeEditorDocument, CodeEditorIndentation};
use crate::{CodeEditorCommand, CodeEditorPosition};

#[test]
fn newline_preserves_leading_whitespace_and_indents_after_an_opener() {
    let mut document = CodeEditorDocument::from_text("    if ready {");
    document.apply(CodeEditorCommand::MoveToLineEnd(
        crate::CodeEditorSelectionMode::Move,
    ));
    document.apply(CodeEditorCommand::Newline);

    assert_eq!(document.text(), "    if ready {\n        ");
    assert_eq!(document.cursor(), document.text().len());
}

#[test]
fn newline_between_a_delimiter_pair_places_the_caret_on_an_indented_line() {
    let mut document = CodeEditorDocument::from_text("fn main() {}");
    document.set_selection(
        CodeEditorPosition {
            row_index: 0,
            byte_offset: 11,
        },
        CodeEditorPosition {
            row_index: 0,
            byte_offset: 11,
        },
    );
    document.apply(CodeEditorCommand::Newline);

    assert_eq!(document.text(), "fn main() {\n    \n}");
    assert_eq!(&document.text()[..document.cursor()], "fn main() {\n    ");
}

#[test]
fn selected_lines_indent_and_outdent_as_single_undoable_edits() {
    let mut document = CodeEditorDocument::from_text("one\n  two\nthree");
    document.set_indentation(CodeEditorIndentation::spaces(2));
    document.set_selection(
        CodeEditorPosition {
            row_index: 0,
            byte_offset: 1,
        },
        CodeEditorPosition {
            row_index: 2,
            byte_offset: 0,
        },
    );

    document.apply(CodeEditorCommand::Indent);
    assert_eq!(document.text(), "  one\n    two\nthree");
    document.apply(CodeEditorCommand::Undo);
    assert_eq!(document.text(), "one\n  two\nthree");

    document.apply(CodeEditorCommand::Indent);
    document.apply(CodeEditorCommand::Outdent);
    assert_eq!(document.text(), "one\n  two\nthree");
}

#[test]
fn tab_indents_at_a_collapsed_caret_and_shift_tab_removes_line_indentation() {
    let mut document = CodeEditorDocument::from_text("  value");
    document.set_indentation(CodeEditorIndentation::spaces(2));
    document.set_selection(
        CodeEditorPosition {
            row_index: 0,
            byte_offset: 2,
        },
        CodeEditorPosition {
            row_index: 0,
            byte_offset: 2,
        },
    );

    document.apply(CodeEditorCommand::Indent);
    assert_eq!(document.text(), "    value");
    document.apply(CodeEditorCommand::Outdent);
    assert_eq!(document.text(), "  value");
}

#[test]
fn tab_indentation_policy_is_explicit() {
    let mut document = CodeEditorDocument::from_text("{");
    document.set_indentation(CodeEditorIndentation::tabs());
    document.apply(CodeEditorCommand::MoveToLineEnd(
        crate::CodeEditorSelectionMode::Move,
    ));
    document.apply(CodeEditorCommand::Newline);

    assert_eq!(document.text(), "{\n\t");
}

#[test]
fn newline_preserves_the_document_crlf_style() {
    let mut document = CodeEditorDocument::from_text("if ready {\r\n}");
    document.set_selection(
        CodeEditorPosition {
            row_index: 0,
            byte_offset: 10,
        },
        CodeEditorPosition {
            row_index: 0,
            byte_offset: 10,
        },
    );

    document.apply(CodeEditorCommand::Newline);

    assert_eq!(document.text(), "if ready {\r\n    \r\n}");
}

#[test]
fn selected_indentation_includes_a_final_empty_line() {
    let mut document = CodeEditorDocument::from_text("one\n");
    document.set_indentation(CodeEditorIndentation::spaces(2));
    document.apply(CodeEditorCommand::SelectAll);

    document.apply(CodeEditorCommand::Indent);
    assert_eq!(document.text(), "  one\n  ");

    document.apply(CodeEditorCommand::Outdent);
    assert_eq!(document.text(), "one\n");
}

#[test]
fn tab_indentation_outdents_one_configured_visual_level_of_spaces() {
    let mut document = CodeEditorDocument::from_text("    value");
    document.set_indentation(CodeEditorIndentation::tabs_with_width(4));

    document.apply(CodeEditorCommand::Outdent);

    assert_eq!(document.text(), "value");
}

#[test]
fn typing_a_closing_delimiter_outdents_leading_whitespace_without_trusting_manual_closers() {
    let mut document = CodeEditorDocument::from_text("    }");
    document.set_indentation(CodeEditorIndentation::spaces(4));
    document.set_selection(
        CodeEditorPosition {
            row_index: 0,
            byte_offset: 4,
        },
        CodeEditorPosition {
            row_index: 0,
            byte_offset: 4,
        },
    );

    document.apply(CodeEditorCommand::Insert("}".to_owned()));

    assert_eq!(document.text(), "}}");
    document.apply(CodeEditorCommand::Undo);
    assert_eq!(document.text(), "    }");
}

#[test]
fn newline_continues_a_rust_line_comment_from_the_syntax_token_context() {
    let mut document = CodeEditorDocument::from_text_with_language(
        "// explain this",
        crate::CodeEditorLanguage::Rust,
    );
    document.apply(CodeEditorCommand::MoveToLineEnd(
        crate::CodeEditorSelectionMode::Move,
    ));

    document.apply(CodeEditorCommand::Newline);

    assert_eq!(document.text(), "// explain this\n// ");
}

#[test]
fn newline_does_not_treat_brackets_inside_a_rust_string_as_structural_openers() {
    let mut document = CodeEditorDocument::from_text_with_language(
        "let brace = \"{\"",
        crate::CodeEditorLanguage::Rust,
    );
    document.apply(CodeEditorCommand::MoveToLineEnd(
        crate::CodeEditorSelectionMode::Move,
    ));

    document.apply(CodeEditorCommand::Newline);

    assert_eq!(document.text(), "let brace = \"{\"\n");
}
