//! Editor-owned line transformations that preserve exact document line endings.

use std::ops::Range;

use super::CodeEditorDocument;
use super::line_endings::preferred_line_ending;

#[path = "line_operations/reordering.rs"]
mod reordering;

/// Selects whether a duplicated line block is inserted before or after its source block.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CodeEditorLineDuplication {
    Above,
    Below,
}

/// Selects whether a line block swaps with the immediately preceding or following line block.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CodeEditorLineMove {
    Up,
    Down,
}

/// Selects whether a blank physical line is inserted before or after a selected line block.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CodeEditorLineInsertion {
    Above,
    Below,
}

/// Selects the lexical direction used to reorder complete selected physical lines.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CodeEditorLineSort {
    Ascending,
    Descending,
}

impl CodeEditorDocument {
    pub(super) fn duplicate_selected_lines(&mut self, direction: CodeEditorLineDuplication) {
        self.cancel_composition();
        self.auto_pairs.clear();
        let block = self.selected_line_block();
        let source = self.text[block.clone()].to_owned();
        let anchor_relative = self.anchor.saturating_sub(block.start);
        let cursor_relative = self.cursor.saturating_sub(block.start);
        let (insertion, insertion_offset, duplicate_start) = if source.is_empty() {
            let line_ending = preferred_line_ending(&self.text);
            match direction {
                CodeEditorLineDuplication::Above => {
                    (line_ending.to_owned(), block.start, block.start)
                }
                CodeEditorLineDuplication::Below => (
                    line_ending.to_owned(),
                    block.end,
                    block.end + line_ending.len(),
                ),
            }
        } else if block.end == self.text.len() {
            let line_ending = preferred_line_ending(&self.text);
            match direction {
                CodeEditorLineDuplication::Above => {
                    (format!("{source}{line_ending}"), block.start, block.start)
                }
                CodeEditorLineDuplication::Below => (
                    format!("{line_ending}{source}"),
                    block.end,
                    block.end + line_ending.len(),
                ),
            }
        } else {
            let duplicate_start = match direction {
                CodeEditorLineDuplication::Above => block.start,
                CodeEditorLineDuplication::Below => block.end,
            };
            (source, duplicate_start, duplicate_start)
        };

        self.checkpoint();
        self.text.insert_str(insertion_offset, &insertion);
        self.anchor = duplicate_start + anchor_relative;
        self.cursor = duplicate_start + cursor_relative;
        self.after_edit();
    }

    pub(super) fn move_selected_lines(&mut self, direction: CodeEditorLineMove) {
        self.cancel_composition();
        self.auto_pairs.clear();
        let block = self.selected_line_block();
        let anchor_relative = self.anchor.saturating_sub(block.start);
        let cursor_relative = self.cursor.saturating_sub(block.start);
        let (replacement_range, replacement, moved_start) = match direction {
            CodeEditorLineMove::Up => {
                if block.start == 0 {
                    return;
                }
                let preceding_start = self
                    .line_ranges
                    .iter()
                    .rposition(|line| line.start < block.start)
                    .map_or(0, |row| self.line_ranges[row].start);
                let source = &self.text[block.clone()];
                let preceding = &self.text[preceding_start..block.start];
                (
                    preceding_start..block.end,
                    format!("{source}{preceding}"),
                    preceding_start,
                )
            }
            CodeEditorLineMove::Down => {
                if block.end == self.text.len() {
                    return;
                }
                let following_row = self.row_index_for_offset(block.end);
                let following_end = self
                    .line_ranges
                    .get(following_row + 1)
                    .map_or(self.text.len(), |line| line.start);
                let source = &self.text[block.clone()];
                let following = &self.text[block.end..following_end];
                let (replacement, moved_start) = if following_end == self.text.len() {
                    let (source_without_ending, line_ending) = split_trailing_line_ending(source)
                        .expect("a non-final line block ends with its preserved line ending");
                    (
                        format!("{following}{line_ending}{source_without_ending}"),
                        block.start + following.len() + line_ending.len(),
                    )
                } else {
                    (
                        format!("{following}{source}"),
                        block.start + following.len(),
                    )
                };
                (block.start..following_end, replacement, moved_start)
            }
        };

        self.checkpoint();
        self.text.replace_range(replacement_range, &replacement);
        self.anchor = moved_start + anchor_relative;
        self.cursor = moved_start + cursor_relative;
        self.after_edit();
    }

    pub(super) fn delete_selected_lines(&mut self) {
        self.cancel_composition();
        self.auto_pairs.clear();
        let block = self.selected_line_block();
        if block.is_empty() {
            return;
        }
        let removal = if block.end == self.text.len() && block.start > 0 {
            let preceding_row = self
                .line_ranges
                .iter()
                .rposition(|line| line.start < block.start)
                .expect("a non-first line block has a preceding source row");
            self.line_ranges[preceding_row].end..block.end
        } else {
            block
        };
        self.checkpoint();
        self.text.replace_range(removal.clone(), "");
        self.collapse(removal.start);
        self.after_edit();
    }

    pub(super) fn delete_empty_selected_lines(&mut self) {
        self.cancel_composition();
        self.auto_pairs.clear();
        let (start_row, end_row) = self.selected_line_rows();
        let empty_rows = (start_row..=end_row)
            .filter(|row| self.line_ranges[*row].is_empty())
            .collect::<Vec<_>>();
        let removals = self.empty_line_removals(&empty_rows);
        if removals.is_empty() {
            return;
        }

        let anchor = offset_after_removing_ranges(self.anchor, &removals);
        let cursor = offset_after_removing_ranges(self.cursor, &removals);
        self.checkpoint();
        for removal in removals.iter().rev() {
            self.text.replace_range(removal.clone(), "");
        }
        self.anchor = anchor;
        self.cursor = cursor;
        self.preferred_column = None;
        self.after_edit();
    }

    pub(super) fn trim_trailing_whitespace(&mut self) {
        self.cancel_composition();
        self.auto_pairs.clear();
        let removals = self
            .line_ranges
            .iter()
            .filter_map(|line| {
                let text = &self.text[line.clone()];
                let trimmed_len = text.trim_end_matches(char::is_whitespace).len();
                (trimmed_len < text.len()).then_some(line.start + trimmed_len..line.end)
            })
            .collect::<Vec<_>>();
        if removals.is_empty() {
            return;
        }

        let anchor = offset_after_removing_ranges(self.anchor, &removals);
        let cursor = offset_after_removing_ranges(self.cursor, &removals);
        self.checkpoint();
        for removal in removals.iter().rev() {
            self.text.replace_range(removal.clone(), "");
        }
        self.anchor = anchor;
        self.cursor = cursor;
        self.preferred_column = None;
        self.after_edit();
    }

    pub(super) fn join_selected_lines(&mut self) {
        self.cancel_composition();
        self.auto_pairs.clear();
        let selection = self.selection_range();
        let (start_row, end_row) = self.selected_line_rows();
        let last_joined_row = if selection.is_empty() || start_row == end_row {
            end_row.saturating_add(1)
        } else {
            end_row
        };
        let endings = (start_row..last_joined_row)
            .filter_map(|row| self.line_ending_after(row))
            .collect::<Vec<_>>();
        if endings.is_empty() {
            return;
        }

        let anchor = offset_after_removing_ranges(self.anchor, &endings);
        let cursor = offset_after_removing_ranges(self.cursor, &endings);
        self.checkpoint();
        for ending in endings.iter().rev() {
            self.text.replace_range(ending.clone(), "");
        }
        self.anchor = anchor;
        self.cursor = cursor;
        self.preferred_column = None;
        self.after_edit();
    }

    pub(super) fn insert_adjacent_line(&mut self, direction: CodeEditorLineInsertion) {
        self.cancel_composition();
        self.auto_pairs.clear();
        let block = self.selected_line_block();
        let insertion_offset = match direction {
            CodeEditorLineInsertion::Above => block.start,
            CodeEditorLineInsertion::Below => block.end,
        };
        let line_ending = preferred_line_ending(&self.text);
        let caret = match direction {
            CodeEditorLineInsertion::Above => insertion_offset,
            CodeEditorLineInsertion::Below if block.end == self.text.len() => {
                insertion_offset + line_ending.len()
            }
            CodeEditorLineInsertion::Below => insertion_offset,
        };
        self.checkpoint();
        self.text.insert_str(insertion_offset, line_ending);
        self.collapse(caret);
        self.after_edit();
    }

    fn selected_line_block(&self) -> Range<usize> {
        let (start_row, end_row) = self.selected_line_rows();
        let start = self.line_ranges[start_row].start;
        let end = self
            .line_ranges
            .get(end_row + 1)
            .map_or(self.text.len(), |line| line.start);
        start..end
    }

    fn selected_line_rows(&self) -> (usize, usize) {
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
        (start_row, end_row)
    }

    fn line_ending_after(&self, row: usize) -> Option<Range<usize>> {
        let line = self.line_ranges.get(row)?;
        let next_line = self.line_ranges.get(row + 1)?;
        Some(line.end..next_line.start)
    }

    fn empty_line_removals(&self, empty_rows: &[usize]) -> Vec<Range<usize>> {
        let mut removals = Vec::new();
        let mut rows = empty_rows.iter().copied().peekable();
        while let Some(first) = rows.next() {
            let mut last = first;
            while rows.peek().is_some_and(|next| *next == last + 1) {
                last = rows
                    .next()
                    .expect("peeked empty-line row must be available");
            }
            let removal = if last + 1 == self.line_ranges.len() {
                if first == 0 {
                    0..self.text.len()
                } else {
                    self.line_ranges[first - 1].end..self.text.len()
                }
            } else {
                self.line_ranges[first].start..self.line_ranges[last + 1].start
            };
            if !removal.is_empty() {
                removals.push(removal);
            }
        }
        removals
    }
}

fn offset_after_removing_ranges(offset: usize, ranges: &[Range<usize>]) -> usize {
    let mut removed = 0;
    for range in ranges {
        if offset < range.start {
            break;
        }
        if offset < range.end {
            return range.start.saturating_sub(removed);
        }
        removed += range.len();
    }
    offset.saturating_sub(removed)
}

fn split_trailing_line_ending(text: &str) -> Option<(&str, &str)> {
    if let Some(without_ending) = text.strip_suffix("\r\n") {
        Some((without_ending, "\r\n"))
    } else if let Some(without_ending) = text.strip_suffix('\n') {
        Some((without_ending, "\n"))
    } else {
        text.strip_suffix('\r')
            .map(|without_ending| (without_ending, "\r"))
    }
}

#[cfg(test)]
#[path = "line_operations_tests.rs"]
mod tests;
