use super::next_word_boundary;
use super::previous_word_boundary;
use crate::CodeEditorCommand;
use crate::CodeEditorDocument;
use crate::CodeEditorNavigation;
use crate::CodeEditorPosition;
use crate::CodeEditorSelectionMode;
use zui::ui::TextInputCompositionEvent;

#[test]
fn word_navigation_keeps_unicode_identifier_runs_and_separator_runs_distinct() {
    let text = "two_words + 世界";
    let mut document = CodeEditorDocument::from_text(text);
    let end = text.len();
    document.set_selection(
        document.position_for_offset(end),
        document.position_for_offset(end),
    );

    document.apply(CodeEditorCommand::MoveWordLeft(
        CodeEditorSelectionMode::Extend,
    ));
    assert_eq!(document.selected_text(), Some("世界"));
    document.apply(CodeEditorCommand::MoveWordLeft(
        CodeEditorSelectionMode::Extend,
    ));
    assert_eq!(document.selected_text(), Some(" + 世界"));
    document.apply(CodeEditorCommand::MoveWordLeft(
        CodeEditorSelectionMode::Extend,
    ));
    assert_eq!(document.selected_text(), Some(text));
}

#[test]
fn word_deletion_preserves_grapheme_boundaries_and_undo_history() {
    let mut document = CodeEditorDocument::from_text("alpha e\u{301}");
    let end = document.text().len();
    document.set_selection(
        document.position_for_offset(end),
        document.position_for_offset(end),
    );

    document.apply(CodeEditorCommand::DeleteWordBackward);
    assert_eq!(document.text(), "alpha ");
    document.apply(CodeEditorCommand::Undo);
    assert_eq!(document.text(), "alpha e\u{301}");
}

#[test]
fn word_boundaries_never_split_combining_graphemes() {
    let text = "e\u{301} + rust";
    assert_eq!(next_word_boundary(text, 0), "e\u{301}".len());
    assert_eq!(previous_word_boundary(text, "e\u{301}".len()), 0);
}

#[test]
fn page_navigation_uses_the_host_visible_row_capacity_for_logical_rows() {
    let mut document = CodeEditorDocument::from_text("zero\none\ntwo\nthree\nfour");
    let navigation = CodeEditorNavigation::LogicalLines { page_rows: 3 };

    document.apply_in_view(
        CodeEditorCommand::MovePageDown(CodeEditorSelectionMode::Move),
        navigation,
    );
    assert_eq!(document.cursor(), "zero\none\ntwo\n".len());
    document.apply_in_view(
        CodeEditorCommand::MovePageUp(CodeEditorSelectionMode::Move),
        navigation,
    );
    assert_eq!(document.cursor(), 0);
}

#[test]
fn page_navigation_uses_wrapped_visual_rows() {
    let mut document = CodeEditorDocument::from_text("abcdefghijkl");
    let navigation = CodeEditorNavigation::SoftWrapped {
        columns: 3,
        page_rows: 2,
    };

    document.apply_in_view(
        CodeEditorCommand::MovePageDown(CodeEditorSelectionMode::Move),
        navigation,
    );
    assert_eq!(document.cursor(), 6);
    document.apply_in_view(
        CodeEditorCommand::MovePageUp(CodeEditorSelectionMode::Move),
        navigation,
    );
    assert_eq!(document.cursor(), 0);
}

#[test]
fn typed_opening_delimiters_pair_wrap_selections_and_skip_existing_closers() {
    let mut document = CodeEditorDocument::from_text("");

    document.apply(CodeEditorCommand::Insert("(".to_owned()));
    assert_eq!(document.text(), "()");
    document.apply(CodeEditorCommand::Insert(")".to_owned()));
    assert_eq!(document.text(), "()");

    let mut document = CodeEditorDocument::from_text("界");
    document.apply(CodeEditorCommand::SelectAll);
    document.apply(CodeEditorCommand::Insert("\"".to_owned()));
    assert_eq!(document.text(), "\"界\"");
    assert_eq!(document.selected_text(), Some("界"));
}

#[test]
fn paired_backspace_and_composition_commit_preserve_text_input_semantics() {
    let mut document = CodeEditorDocument::from_text("");
    document.apply(CodeEditorCommand::Insert("{".to_owned()));
    document.apply(CodeEditorCommand::Backspace);
    assert_eq!(document.text(), "");

    document.apply_composition(TextInputCompositionEvent::Commit("\"".to_owned()));
    assert_eq!(document.text(), "\"");
}

#[test]
fn manually_authored_delimiters_are_never_overtype_or_paired_backspace_targets() {
    let mut document = CodeEditorDocument::from_text("()");
    let position = CodeEditorPosition {
        row_index: 0,
        byte_offset: 1,
    };
    document.set_selection(position, position);

    document.apply(CodeEditorCommand::Insert(")".to_owned()));
    assert_eq!(document.text(), "())");
    document.apply(CodeEditorCommand::Backspace);
    assert_eq!(document.text(), "()");
}
