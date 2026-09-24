//! Reordering transformations for complete selected physical lines.

use std::collections::HashSet;

use super::CodeEditorDocument;
use super::CodeEditorLineSort;

impl CodeEditorDocument {
    pub(in crate::code_editor) fn sort_selected_lines(&mut self, direction: CodeEditorLineSort) {
        let Some((start_row, end_row)) = self.multiple_selected_line_rows() else {
            return;
        };
        let mut lines = self.selected_line_texts(start_row, end_row);
        match direction {
            CodeEditorLineSort::Ascending => lines.sort(),
            CodeEditorLineSort::Descending => lines.sort_by(|left, right| right.cmp(left)),
        }
        self.replace_selected_line_texts(start_row, end_row, lines);
    }

    pub(in crate::code_editor) fn reverse_selected_lines(&mut self) {
        let Some((start_row, end_row)) = self.multiple_selected_line_rows() else {
            return;
        };
        let mut lines = self.selected_line_texts(start_row, end_row);
        lines.reverse();
        self.replace_selected_line_texts(start_row, end_row, lines);
    }

    pub(in crate::code_editor) fn remove_duplicate_selected_lines(&mut self) {
        let Some((start_row, end_row)) = self.multiple_selected_line_rows() else {
            return;
        };
        let mut seen = HashSet::new();
        let lines = self
            .selected_line_texts(start_row, end_row)
            .into_iter()
            .filter(|line| seen.insert(line.clone()))
            .collect();
        self.replace_selected_line_texts(start_row, end_row, lines);
    }

    fn multiple_selected_line_rows(&mut self) -> Option<(usize, usize)> {
        self.cancel_composition();
        self.auto_pairs.clear();
        (!self.selection_range().is_empty())
            .then(|| self.selected_line_rows())
            .filter(|(start_row, end_row)| start_row < end_row)
    }

    fn selected_line_texts(&self, start_row: usize, end_row: usize) -> Vec<String> {
        self.line_ranges[start_row..=end_row]
            .iter()
            .map(|line| self.text[line.clone()].to_owned())
            .collect()
    }

    fn replace_selected_line_texts(
        &mut self,
        start_row: usize,
        end_row: usize,
        lines: Vec<String>,
    ) {
        let block = self.selected_line_block();
        let has_trailing_ending = self.line_ranges[end_row].end < block.end;
        let ending_count = lines.len().saturating_sub(1) + usize::from(has_trailing_ending);
        let mut replacement = String::with_capacity(block.len());
        for (index, line) in lines.iter().enumerate() {
            replacement.push_str(line);
            if index < ending_count {
                let source_row = start_row + index;
                let ending_end = self.line_ranges[source_row + 1].start;
                replacement.push_str(&self.text[self.line_ranges[source_row].end..ending_end]);
            }
        }
        if replacement == self.text[block.clone()] {
            return;
        }

        let selection_is_forward = self.anchor <= self.cursor;
        let new_block_end = block.start + replacement.len();
        self.checkpoint();
        self.text.replace_range(block.clone(), &replacement);
        if selection_is_forward {
            self.anchor = block.start;
            self.cursor = new_block_end;
        } else {
            self.anchor = new_block_end;
            self.cursor = block.start;
        }
        self.preferred_column = None;
        self.after_edit();
    }
}

#[cfg(test)]
#[path = "reordering_tests.rs"]
mod tests;
