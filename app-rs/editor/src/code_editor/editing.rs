use std::ops::Range;

use unicode_segmentation::UnicodeSegmentation;
use zui::ui::{TextInputCompositionCursor, TextInputCompositionEvent, TextInputSelectionMode};

use super::language_configuration::is_closing_delimiter;
use super::language_configuration::paired_delimiter_close;
use super::line_operations::CodeEditorLineDuplication;
use super::line_operations::CodeEditorLineInsertion;
use super::line_operations::CodeEditorLineMove;
use super::line_operations::CodeEditorLineSort;
use super::wrapping::CodeEditorVisualProjection;
use super::{
    CodeEditorDocument, CodeEditorLineWrapping, CodeEditorNavigation, CodeEditorRowSource,
};

/// Whether navigation collapses or extends the current CodeEditor selection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CodeEditorSelectionMode {
    Move,
    Extend,
}

impl From<CodeEditorSelectionMode> for TextInputSelectionMode {
    fn from(mode: CodeEditorSelectionMode) -> Self {
        match mode {
            CodeEditorSelectionMode::Move => Self::Move,
            CodeEditorSelectionMode::Extend => Self::Extend,
        }
    }
}

/// Platform-independent editing commands accepted by a multiline CodeEditor document.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodeEditorCommand {
    Insert(String),
    Newline,
    Indent,
    Outdent,
    MoveLeft(CodeEditorSelectionMode),
    MoveRight(CodeEditorSelectionMode),
    MoveWordLeft(CodeEditorSelectionMode),
    MoveWordRight(CodeEditorSelectionMode),
    MoveUp(CodeEditorSelectionMode),
    MoveDown(CodeEditorSelectionMode),
    MovePageUp(CodeEditorSelectionMode),
    MovePageDown(CodeEditorSelectionMode),
    DuplicateLinesAbove,
    DuplicateLinesBelow,
    MoveLinesUp,
    MoveLinesDown,
    DeleteLines,
    DeleteEmptyLines,
    TrimTrailingWhitespace,
    SortLinesAscending,
    SortLinesDescending,
    ReverseSelectedLines,
    RemoveDuplicateLines,
    ToggleLineComment,
    ToggleManualFoldSelection,
    JoinLines,
    InsertLineAbove,
    InsertLineBelow,
    MoveToLineStart(CodeEditorSelectionMode),
    MoveToLineEnd(CodeEditorSelectionMode),
    SelectAll,
    Backspace,
    DeleteForward,
    DeleteWordBackward,
    DeleteWordForward,
    Undo,
    Redo,
}

/// Exact UTF-8 document edit supplied by a trusted editor feature adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodeEditorTextEdit {
    pub range: Range<usize>,
    pub new_text: String,
}

impl CodeEditorDocument {
    pub fn apply(&mut self, command: CodeEditorCommand) {
        self.apply_in_view(command, CodeEditorNavigation::default());
    }

    /// Applies one exact edit while preserving the document's undo, analysis, and revision rules.
    pub fn apply_text_edit(&mut self, edit: CodeEditorTextEdit) -> bool {
        if edit.range.start > edit.range.end
            || edit.range.end > self.text.len()
            || !self.text.is_char_boundary(edit.range.start)
            || !self.text.is_char_boundary(edit.range.end)
        {
            return false;
        }
        self.cancel_composition();
        self.checkpoint();
        self.auto_pairs
            .apply_text_edit(edit.range.clone(), edit.new_text.len());
        self.text.replace_range(edit.range.clone(), &edit.new_text);
        self.collapse(edit.range.start + edit.new_text.len());
        self.after_edit();
        true
    }

    /// Applies a command using the visual-line geometry resolved by a CodeEditor presentation.
    pub fn apply_in_view(&mut self, command: CodeEditorCommand, navigation: CodeEditorNavigation) {
        match command {
            CodeEditorCommand::Insert(text) => self.insert(&editable_text(&text)),
            CodeEditorCommand::Newline => self.insert_newline_with_indentation(),
            CodeEditorCommand::Indent => self.indent(),
            CodeEditorCommand::Outdent => self.outdent(),
            CodeEditorCommand::MoveLeft(mode) => self.move_left(mode),
            CodeEditorCommand::MoveRight(mode) => self.move_right(mode),
            CodeEditorCommand::MoveWordLeft(mode) => self.move_word_left(mode),
            CodeEditorCommand::MoveWordRight(mode) => self.move_word_right(mode),
            CodeEditorCommand::MoveUp(mode) => self.move_vertical_in_view(-1, mode, navigation),
            CodeEditorCommand::MoveDown(mode) => self.move_vertical_in_view(1, mode, navigation),
            CodeEditorCommand::MovePageUp(mode) => self.move_page_in_view(-1, mode, navigation),
            CodeEditorCommand::MovePageDown(mode) => self.move_page_in_view(1, mode, navigation),
            CodeEditorCommand::DuplicateLinesAbove => {
                self.duplicate_selected_lines(CodeEditorLineDuplication::Above)
            }
            CodeEditorCommand::DuplicateLinesBelow => {
                self.duplicate_selected_lines(CodeEditorLineDuplication::Below)
            }
            CodeEditorCommand::MoveLinesUp => self.move_selected_lines(CodeEditorLineMove::Up),
            CodeEditorCommand::MoveLinesDown => self.move_selected_lines(CodeEditorLineMove::Down),
            CodeEditorCommand::DeleteLines => self.delete_selected_lines(),
            CodeEditorCommand::DeleteEmptyLines => self.delete_empty_selected_lines(),
            CodeEditorCommand::TrimTrailingWhitespace => self.trim_trailing_whitespace(),
            CodeEditorCommand::SortLinesAscending => {
                self.sort_selected_lines(CodeEditorLineSort::Ascending)
            }
            CodeEditorCommand::SortLinesDescending => {
                self.sort_selected_lines(CodeEditorLineSort::Descending)
            }
            CodeEditorCommand::ReverseSelectedLines => self.reverse_selected_lines(),
            CodeEditorCommand::RemoveDuplicateLines => self.remove_duplicate_selected_lines(),
            CodeEditorCommand::ToggleLineComment => self.toggle_line_comment(),
            CodeEditorCommand::ToggleManualFoldSelection => {
                self.toggle_manual_folding_selection();
            }
            CodeEditorCommand::JoinLines => self.join_selected_lines(),
            CodeEditorCommand::InsertLineAbove => {
                self.insert_adjacent_line(CodeEditorLineInsertion::Above)
            }
            CodeEditorCommand::InsertLineBelow => {
                self.insert_adjacent_line(CodeEditorLineInsertion::Below)
            }
            CodeEditorCommand::MoveToLineStart(mode) => {
                self.move_cursor(self.current_line_range().start, mode)
            }
            CodeEditorCommand::MoveToLineEnd(mode) => {
                self.move_cursor(self.current_line_range().end, mode)
            }
            CodeEditorCommand::SelectAll => {
                self.cancel_composition();
                self.anchor = 0;
                self.cursor = self.text.len();
            }
            CodeEditorCommand::Backspace => self.backspace(),
            CodeEditorCommand::DeleteForward => self.delete_forward(),
            CodeEditorCommand::DeleteWordBackward => self.delete_word_backward(),
            CodeEditorCommand::DeleteWordForward => self.delete_word_forward(),
            CodeEditorCommand::Undo => self.undo(),
            CodeEditorCommand::Redo => self.redo(),
        }
    }

    pub fn apply_composition(&mut self, event: TextInputCompositionEvent) {
        match event {
            TextInputCompositionEvent::Preedit { text, cursor } => {
                let text = editable_text(&text);
                if text.is_empty() {
                    self.composition = None;
                } else {
                    self.composition = Some(super::document::Composition {
                        cursor: clamp_composition_cursor(&text, cursor),
                        text,
                    });
                }
            }
            TextInputCompositionEvent::Commit(text) => {
                self.composition = None;
                self.insert_plain(&editable_text(&text));
            }
            TextInputCompositionEvent::Cancel => self.cancel_composition(),
        }
    }

    pub fn cancel_composition(&mut self) {
        self.composition = None;
    }

    pub fn can_undo(&self) -> bool {
        self.core.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.core.can_redo()
    }

    fn insert(&mut self, text: &str) {
        self.cancel_composition();
        if text.is_empty() {
            return;
        }
        if self.insert_closing_delimiter_with_outdent(text) {
            return;
        }
        if self.insert_paired_delimiter(text) {
            return;
        }
        self.insert_plain(text);
    }

    fn insert_plain(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.checkpoint();
        let selection = self.selection_range();
        self.auto_pairs
            .apply_text_edit(selection.clone(), text.len());
        self.text.replace_range(selection.clone(), text);
        self.collapse(selection.start + text.len());
        self.after_edit();
    }

    fn insert_paired_delimiter(&mut self, text: &str) -> bool {
        if self.has_selection() {
            let Some(close) = paired_delimiter_close(self.language(), text) else {
                return false;
            };
            let selection = self.selection_range();
            let mut replacement = String::with_capacity(text.len() + selection.len() + close.len());
            replacement.push_str(text);
            replacement.push_str(&self.text[selection.clone()]);
            replacement.push_str(close);
            self.checkpoint();
            self.auto_pairs
                .apply_text_edit(selection.clone(), replacement.len());
            self.text.replace_range(selection.clone(), &replacement);
            let offset = text.len();
            self.anchor += offset;
            self.cursor += offset;
            self.preferred_column = None;
            self.after_edit();
            return true;
        }

        if is_closing_delimiter(self.language(), text)
            && self.auto_pairs.contains_close_at(self.cursor, text)
            && self
                .text
                .get(self.cursor..)
                .is_some_and(|remaining| remaining.starts_with(text))
        {
            self.collapse(self.cursor + text.len());
            return true;
        }

        let Some(close) = paired_delimiter_close(self.language(), text) else {
            return false;
        };
        self.checkpoint();
        let opening = self.cursor..self.cursor + text.len();
        let closing = opening.end..opening.end + close.len();
        self.auto_pairs
            .apply_text_edit(self.cursor..self.cursor, text.len() + close.len());
        self.text.insert_str(self.cursor, text);
        self.text.insert_str(self.cursor + text.len(), close);
        self.auto_pairs.record(opening, closing);
        self.collapse(self.cursor + text.len());
        self.after_edit();
        true
    }

    fn insert_closing_delimiter_with_outdent(&mut self, text: &str) -> bool {
        if self.has_selection() || !is_closing_delimiter(self.language(), text) {
            return false;
        }
        let Some(removal) = self.removable_current_line_indentation_before_cursor() else {
            return false;
        };
        self.checkpoint();
        self.auto_pairs.apply_text_edit(removal.clone(), 0);
        self.text.replace_range(removal.clone(), "");
        let insertion = self.cursor - removal.len();
        if self.auto_pairs.contains_close_at(insertion, text)
            && self
                .text
                .get(insertion..)
                .is_some_and(|remaining| remaining.starts_with(text))
        {
            self.collapse(insertion + text.len());
        } else {
            self.auto_pairs
                .apply_text_edit(insertion..insertion, text.len());
            self.text.insert_str(insertion, text);
            self.collapse(insertion + text.len());
        }
        self.after_edit();
        true
    }

    fn move_left(&mut self, mode: CodeEditorSelectionMode) {
        self.cancel_composition();
        if mode == CodeEditorSelectionMode::Move && self.has_selection() {
            self.collapse(self.selection_range().start);
            return;
        }
        let cursor = previous_boundary(&self.text, self.cursor);
        self.move_cursor(cursor, mode);
    }

    fn move_right(&mut self, mode: CodeEditorSelectionMode) {
        self.cancel_composition();
        if mode == CodeEditorSelectionMode::Move && self.has_selection() {
            self.collapse(self.selection_range().end);
            return;
        }
        let cursor = next_boundary(&self.text, self.cursor);
        self.move_cursor(cursor, mode);
    }

    fn move_word_left(&mut self, mode: CodeEditorSelectionMode) {
        self.cancel_composition();
        if mode == CodeEditorSelectionMode::Move && self.has_selection() {
            self.collapse(self.selection_range().start);
            return;
        }
        self.move_cursor(previous_word_boundary(&self.text, self.cursor), mode);
    }

    fn move_word_right(&mut self, mode: CodeEditorSelectionMode) {
        self.cancel_composition();
        if mode == CodeEditorSelectionMode::Move && self.has_selection() {
            self.collapse(self.selection_range().end);
            return;
        }
        self.move_cursor(next_word_boundary(&self.text, self.cursor), mode);
    }

    fn move_vertical(&mut self, direction: isize, mode: CodeEditorSelectionMode) {
        self.cancel_composition();
        let source_row = self.row_index_for_offset(self.cursor);
        self.reveal_source_row(source_row);
        let Some(row) = self.visual_row_for_source(source_row) else {
            return;
        };
        let target = if direction.is_negative() {
            row.checked_sub(direction.unsigned_abs())
        } else {
            row.checked_add(direction as usize)
                .filter(|index| *index < self.folding.row_count())
        };
        let Some(target) = target.and_then(|row| self.source_row_for_visual(row)) else {
            return;
        };
        let current = self.current_line_range();
        let requested_column = self.preferred_column.unwrap_or_else(|| {
            super::text_metrics::display_columns_until(
                &self.text[current.clone()],
                self.cursor.saturating_sub(current.start),
            )
        });
        let target_range = self.line_ranges[target].clone();
        let relative = super::text_metrics::byte_offset_for_column(
            &self.text[target_range.clone()],
            requested_column,
        );
        self.preferred_column = Some(requested_column);
        self.move_cursor_preserving_column(target_range.start + relative, mode);
    }

    fn move_vertical_in_view(
        &mut self,
        direction: isize,
        mode: CodeEditorSelectionMode,
        navigation: CodeEditorNavigation,
    ) {
        match navigation {
            CodeEditorNavigation::LogicalLines { .. } => self.move_vertical(direction, mode),
            CodeEditorNavigation::SoftWrapped { columns, .. } => {
                self.move_vertical_wrapped(direction, mode, columns.max(1));
            }
        }
    }

    fn move_page_in_view(
        &mut self,
        direction: isize,
        mode: CodeEditorSelectionMode,
        navigation: CodeEditorNavigation,
    ) {
        let page_rows = isize::try_from(navigation.page_rows().max(1)).unwrap_or(isize::MAX);
        self.move_vertical_in_view(direction.saturating_mul(page_rows), mode, navigation);
    }

    fn move_vertical_wrapped(
        &mut self,
        direction: isize,
        mode: CodeEditorSelectionMode,
        columns: usize,
    ) {
        self.cancel_composition();
        let source_row = self.row_index_for_offset(self.cursor);
        self.reveal_source_row(source_row);
        let projection =
            CodeEditorVisualProjection::new(self, CodeEditorLineWrapping::Soft, columns);
        let position = self.position_for_offset(self.cursor);
        let Some(current_index) = projection.visual_line_for_position(self, position) else {
            return;
        };
        let Some(current_line) = projection.line(self, current_index) else {
            return;
        };
        let target_index = if direction.is_negative() {
            current_index.checked_sub(direction.unsigned_abs())
        } else {
            current_index
                .checked_add(direction as usize)
                .filter(|index| *index < projection.len())
        };
        let Some(target_line) = target_index.and_then(|index| projection.line(self, index)) else {
            return;
        };
        let current_range = self.line_ranges[source_row].clone();
        let current_column = super::text_metrics::display_columns_until(
            &self.text[current_range.clone()],
            self.cursor.saturating_sub(current_range.start),
        );
        let requested_column = self
            .preferred_column
            .unwrap_or_else(|| current_column.saturating_sub(current_line.start_column));
        let target_source_row = self.source_row(target_line.row_index).unwrap_or(source_row);
        let target_range = self.line_ranges[target_source_row].clone();
        let target_column = target_line
            .start_column
            .saturating_add(requested_column)
            .min(target_line.end_column);
        let relative = super::text_metrics::byte_offset_for_column(
            &self.text[target_range.clone()],
            target_column,
        );
        self.preferred_column = Some(requested_column);
        self.move_cursor_preserving_column(target_range.start + relative, mode);
    }

    fn backspace(&mut self) {
        self.cancel_composition();
        if self.delete_selection() {
            return;
        }
        let start = previous_boundary(&self.text, self.cursor);
        if start == self.cursor {
            return;
        }
        let end = next_boundary(&self.text, self.cursor);
        if end > self.cursor
            && self
                .auto_pairs
                .pair_around(start..self.cursor, self.cursor..end)
        {
            self.checkpoint();
            self.auto_pairs
                .remove_pair_around(start..self.cursor, self.cursor..end);
            self.auto_pairs.apply_text_edit(start..end, 0);
            self.text.replace_range(start..end, "");
            self.collapse(start);
            self.after_edit();
            return;
        }
        self.checkpoint();
        self.auto_pairs.apply_text_edit(start..self.cursor, 0);
        self.text.replace_range(start..self.cursor, "");
        self.collapse(start);
        self.after_edit();
    }

    fn delete_forward(&mut self) {
        self.cancel_composition();
        if self.delete_selection() {
            return;
        }
        let end = next_boundary(&self.text, self.cursor);
        if end == self.cursor {
            return;
        }
        self.checkpoint();
        self.auto_pairs.apply_text_edit(self.cursor..end, 0);
        self.text.replace_range(self.cursor..end, "");
        self.after_edit();
    }

    fn delete_word_backward(&mut self) {
        self.cancel_composition();
        if self.delete_selection() {
            return;
        }
        let start = previous_word_boundary(&self.text, self.cursor);
        if start == self.cursor {
            return;
        }
        self.checkpoint();
        self.auto_pairs.apply_text_edit(start..self.cursor, 0);
        self.text.replace_range(start..self.cursor, "");
        self.collapse(start);
        self.after_edit();
    }

    fn delete_word_forward(&mut self) {
        self.cancel_composition();
        if self.delete_selection() {
            return;
        }
        let end = next_word_boundary(&self.text, self.cursor);
        if end == self.cursor {
            return;
        }
        self.checkpoint();
        self.auto_pairs.apply_text_edit(self.cursor..end, 0);
        self.text.replace_range(self.cursor..end, "");
        self.after_edit();
    }

    fn delete_selection(&mut self) -> bool {
        if !self.has_selection() {
            return false;
        }
        self.checkpoint();
        let selection = self.selection_range();
        self.auto_pairs.apply_text_edit(selection.clone(), 0);
        self.text.replace_range(selection.clone(), "");
        self.collapse(selection.start);
        self.after_edit();
        true
    }

    pub(super) fn checkpoint(&mut self) {
        self.synchronize_core_selection();
    }

    fn undo(&mut self) {
        let Some(snapshot) = self.core.undo() else {
            return;
        };
        self.adopt_core_snapshot(&snapshot);
    }

    fn redo(&mut self) {
        let Some(snapshot) = self.core.redo() else {
            return;
        };
        self.adopt_core_snapshot(&snapshot);
    }

    pub(super) fn after_edit(&mut self) {
        self.preferred_column = None;
        self.manual_folding_ranges.clear();
        self.reindex_lines();
        self.refresh_syntax();
        self.commit_native_text_mutation();
    }

    fn move_cursor(&mut self, cursor: usize, mode: CodeEditorSelectionMode) {
        self.preferred_column = None;
        self.move_cursor_preserving_column(cursor, mode);
    }

    fn move_cursor_preserving_column(&mut self, cursor: usize, mode: CodeEditorSelectionMode) {
        self.cursor = clamp_boundary(&self.text, cursor);
        self.reveal_source_row(self.row_index_for_offset(self.cursor));
        if mode == CodeEditorSelectionMode::Move {
            self.anchor = self.cursor;
        }
    }

    pub(super) fn collapse(&mut self, cursor: usize) {
        self.anchor = cursor;
        self.cursor = cursor;
        self.preferred_column = None;
    }

    fn has_selection(&self) -> bool {
        self.anchor != self.cursor
    }

    pub(super) fn selection_range(&self) -> Range<usize> {
        self.anchor.min(self.cursor)..self.anchor.max(self.cursor)
    }
}

/// Returns whether one Unicode grapheme belongs to an identifier-like word run.
///
/// Keeping underscore in the same run as letters and numbers matches source-code navigation,
/// while grapheme iteration keeps a command from splitting combining sequences or emoji.
fn is_word_grapheme(grapheme: &str) -> bool {
    grapheme
        .chars()
        .any(|character| character == '_' || character.is_alphanumeric())
}

fn previous_word_boundary(text: &str, cursor: usize) -> usize {
    let cursor = grapheme_boundary_at_or_before(text, cursor);
    let mut segments = text[..cursor].grapheme_indices(true).rev();
    let Some((start, first)) = segments.next() else {
        return 0;
    };
    let word = is_word_grapheme(first);
    let mut boundary = start;
    for (offset, grapheme) in segments {
        if is_word_grapheme(grapheme) != word {
            break;
        }
        boundary = offset;
    }
    boundary
}

fn next_word_boundary(text: &str, cursor: usize) -> usize {
    let cursor = grapheme_boundary_at_or_before(text, cursor);
    let mut segments = text[cursor..]
        .grapheme_indices(true)
        .map(|(offset, grapheme)| (cursor + offset, grapheme))
        .peekable();
    let Some((_, first)) = segments.peek().copied() else {
        return cursor;
    };
    let word = is_word_grapheme(first);
    for (offset, grapheme) in segments {
        if is_word_grapheme(grapheme) != word {
            return offset;
        }
    }
    text.len()
}

fn grapheme_boundary_at_or_before(text: &str, offset: usize) -> usize {
    let offset = offset.min(text.len());
    if offset == text.len() {
        return offset;
    }
    text.grapheme_indices(true)
        .map(|(index, _)| index)
        .take_while(|index| *index <= offset)
        .last()
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "editing_tests.rs"]
mod tests;

fn previous_boundary(text: &str, cursor: usize) -> usize {
    let cursor = clamp_boundary(text, cursor);
    if cursor >= 2 && &text.as_bytes()[cursor - 2..cursor] == b"\r\n" {
        return cursor - 2;
    }
    text[..cursor]
        .grapheme_indices(true)
        .next_back()
        .map(|(index, _)| index)
        .unwrap_or(0)
}

fn next_boundary(text: &str, cursor: usize) -> usize {
    let cursor = clamp_boundary(text, cursor);
    if text.as_bytes().get(cursor..cursor + 2) == Some(b"\r\n") {
        return cursor + 2;
    }
    text[cursor..]
        .grapheme_indices(true)
        .nth(1)
        .map(|(index, _)| cursor + index)
        .unwrap_or(text.len())
}

fn clamp_boundary(text: &str, requested: usize) -> usize {
    let mut index = requested.min(text.len());
    while !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

pub(super) fn editable_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .chars()
        .filter(|character| matches!(character, '\n' | '\t') || !character.is_control())
        .collect()
}

fn clamp_composition_cursor(
    text: &str,
    cursor: TextInputCompositionCursor,
) -> TextInputCompositionCursor {
    match cursor {
        TextInputCompositionCursor::Visible(cursor) => {
            let start = clamp_boundary(text, cursor.start);
            let end = clamp_boundary(text, cursor.end);
            TextInputCompositionCursor::Visible(start.min(end)..start.max(end))
        }
        TextInputCompositionCursor::Hidden => TextInputCompositionCursor::Hidden,
    }
}
