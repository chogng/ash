//! Language-declared line comment commands applied through one document transaction.

use std::ops::Range;

use super::CodeEditorDocument;
use super::language_configuration::line_comment_marker;

impl CodeEditorDocument {
    pub(super) fn toggle_line_comment(&mut self) {
        self.cancel_composition();
        let Some(marker) = line_comment_marker(self.language()) else {
            return;
        };
        let rows = self.selected_comment_rows();
        let removals = rows
            .iter()
            .filter_map(|row| self.line_comment_prefix(*row, marker))
            .collect::<Vec<_>>();
        if removals.len() == rows.len() {
            self.remove_line_comments(removals);
        } else {
            self.insert_line_comments(rows, marker);
        }
    }

    fn selected_comment_rows(&self) -> Vec<usize> {
        let selection = self.selection_range();
        let start_row = self.row_index_for_offset(selection.start);
        let mut end_row = self.row_index_for_offset(selection.end);
        if !selection.is_empty()
            && selection.end < self.text.len()
            && end_row > start_row
            && self
                .line_ranges
                .get(end_row)
                .is_some_and(|line| line.start == selection.end)
        {
            end_row -= 1;
        }
        (start_row..=end_row).collect()
    }

    fn line_comment_prefix(&self, row: usize, marker: &str) -> Option<Range<usize>> {
        let line = self.line_ranges.get(row)?;
        let text = &self.text[line.clone()];
        let indentation = text
            .char_indices()
            .take_while(|(_, character)| matches!(character, ' ' | '\t'))
            .last()
            .map_or(0, |(offset, character)| offset + character.len_utf8());
        let remaining = &text[indentation..];
        remaining.starts_with(marker).then(|| {
            let mut end = line.start + indentation + marker.len();
            if self.text[end..line.end].starts_with(' ') {
                end += 1;
            }
            line.start + indentation..end
        })
    }

    fn insert_line_comments(&mut self, rows: Vec<usize>, marker: &str) {
        let insertions = rows
            .iter()
            .map(|row| self.comment_insertion_offset(*row))
            .collect::<Vec<_>>();
        let insertion = format!("{marker} ");
        self.auto_pairs.clear();
        self.checkpoint();
        for offset in insertions.iter().rev() {
            self.text.insert_str(*offset, &insertion);
        }
        self.anchor = offset_after_insertions(self.anchor, &insertions, insertion.len());
        self.cursor = offset_after_insertions(self.cursor, &insertions, insertion.len());
        self.preferred_column = None;
        self.after_edit();
    }

    fn remove_line_comments(&mut self, removals: Vec<Range<usize>>) {
        let anchor = offset_after_removals(self.anchor, &removals);
        let cursor = offset_after_removals(self.cursor, &removals);
        self.auto_pairs.clear();
        self.checkpoint();
        for removal in removals.iter().rev() {
            self.text.replace_range(removal.clone(), "");
        }
        self.anchor = anchor;
        self.cursor = cursor;
        self.preferred_column = None;
        self.after_edit();
    }

    fn comment_insertion_offset(&self, row: usize) -> usize {
        let line = &self.line_ranges[row];
        line.start
            + self.text[line.clone()]
                .char_indices()
                .take_while(|(_, character)| matches!(character, ' ' | '\t'))
                .last()
                .map_or(0, |(offset, character)| offset + character.len_utf8())
    }
}

fn offset_after_insertions(offset: usize, insertions: &[usize], inserted_len: usize) -> usize {
    offset
        + insertions
            .iter()
            .filter(|insertion| **insertion <= offset)
            .count()
            * inserted_len
}

fn offset_after_removals(offset: usize, removals: &[Range<usize>]) -> usize {
    removals.iter().fold(offset, |mapped, removal| {
        if offset <= removal.start {
            mapped
        } else {
            mapped.saturating_sub((offset - removal.start).min(removal.len()))
        }
    })
}

#[cfg(test)]
#[path = "language_editing_tests.rs"]
mod tests;
