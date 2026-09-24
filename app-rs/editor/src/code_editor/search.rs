//! Editor-owned search and replacement over committed document text.

use std::ops::Range;

use super::CodeEditorDocument;
use super::editing::editable_text;

/// Case comparison policy for CodeEditor search queries.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum CodeEditorCaseSensitivity {
    /// Match Unicode text exactly.
    #[default]
    Sensitive,
    /// Ignore ASCII letter case while preserving source byte offsets.
    AsciiInsensitive,
}

/// An owned search query whose comparison policy is independent from Native UI state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodeEditorSearchQuery {
    text: String,
    case_sensitivity: CodeEditorCaseSensitivity,
}

impl CodeEditorSearchQuery {
    /// Creates an exact, case-sensitive query.
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            case_sensitivity: CodeEditorCaseSensitivity::Sensitive,
        }
    }

    /// Selects an explicit case-comparison policy.
    pub const fn with_case_sensitivity(
        mut self,
        case_sensitivity: CodeEditorCaseSensitivity,
    ) -> Self {
        self.case_sensitivity = case_sensitivity;
        self
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub const fn case_sensitivity(&self) -> CodeEditorCaseSensitivity {
        self.case_sensitivity
    }

    fn matches(&self, candidate: &str) -> bool {
        match self.case_sensitivity {
            CodeEditorCaseSensitivity::Sensitive => candidate == self.text,
            CodeEditorCaseSensitivity::AsciiInsensitive => {
                candidate.eq_ignore_ascii_case(&self.text)
            }
        }
    }
}

/// One committed-text match expressed as both a byte range and CodeEditor positions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodeEditorSearchMatch {
    byte_range: Range<usize>,
    start: super::CodeEditorPosition,
    end: super::CodeEditorPosition,
}

impl CodeEditorSearchMatch {
    pub fn byte_range(&self) -> Range<usize> {
        self.byte_range.clone()
    }

    pub const fn start(&self) -> super::CodeEditorPosition {
        self.start
    }

    pub const fn end(&self) -> super::CodeEditorPosition {
        self.end
    }
}

impl CodeEditorDocument {
    /// Returns every non-overlapping committed-text match in source order.
    pub fn search_matches(&self, query: &CodeEditorSearchQuery) -> Vec<CodeEditorSearchMatch> {
        search_ranges(&self.text, query)
            .into_iter()
            .map(|range| self.search_match(range))
            .collect()
    }

    /// Selects the next match after the active selection, wrapping at the document end.
    pub fn find_next(&mut self, query: &CodeEditorSearchQuery) -> Option<CodeEditorSearchMatch> {
        let ranges = search_ranges(&self.text, query);
        let origin = self.selection_range().end;
        let range = ranges
            .iter()
            .find(|range| range.start >= origin)
            .or_else(|| ranges.first())?
            .clone();
        Some(self.select_search_match(range))
    }

    /// Selects the first match at or after the active selection start, wrapping at document end.
    ///
    /// Native incremental-search inputs use this so extending a query keeps a matching result at
    /// the same source location instead of advancing to the following result.
    pub fn find_nearest(&mut self, query: &CodeEditorSearchQuery) -> Option<CodeEditorSearchMatch> {
        let ranges = search_ranges(&self.text, query);
        let origin = self.selection_range().start;
        let range = ranges
            .iter()
            .find(|range| range.start >= origin)
            .or_else(|| ranges.first())?
            .clone();
        Some(self.select_search_match(range))
    }

    /// Selects the previous match before the active selection, wrapping at the document start.
    pub fn find_previous(
        &mut self,
        query: &CodeEditorSearchQuery,
    ) -> Option<CodeEditorSearchMatch> {
        let ranges = search_ranges(&self.text, query);
        let origin = self.selection_range().start;
        let range = ranges
            .iter()
            .rev()
            .find(|range| range.end <= origin)
            .or_else(|| ranges.last())?
            .clone();
        Some(self.select_search_match(range))
    }

    /// Replaces the selected match as one undoable edit.
    pub fn replace_current(&mut self, query: &CodeEditorSearchQuery, replacement: &str) -> bool {
        let selection = self.selection_range();
        if selection.is_empty() || !query.matches(&self.text[selection.clone()]) {
            return false;
        }
        let replacement = editable_text(replacement);
        self.checkpoint();
        self.auto_pairs.clear();
        self.text.replace_range(selection.clone(), &replacement);
        self.collapse(selection.start + replacement.len());
        self.after_edit();
        true
    }

    /// Replaces every non-overlapping match as one undoable edit and returns the replacement count.
    pub fn replace_all(&mut self, query: &CodeEditorSearchQuery, replacement: &str) -> usize {
        let ranges = search_ranges(&self.text, query);
        if ranges.is_empty() {
            return 0;
        }
        let replacement = editable_text(replacement);
        let anchor = transformed_offset(self.anchor, &ranges, replacement.len());
        let cursor = transformed_offset(self.cursor, &ranges, replacement.len());
        self.checkpoint();
        self.auto_pairs.clear();
        for range in ranges.iter().rev() {
            self.text.replace_range(range.clone(), &replacement);
        }
        self.anchor = anchor;
        self.cursor = cursor;
        self.after_edit();
        ranges.len()
    }

    fn select_search_match(&mut self, range: Range<usize>) -> CodeEditorSearchMatch {
        self.cancel_composition();
        self.anchor = range.start;
        self.cursor = range.end;
        self.preferred_column = None;
        self.reveal_source_row(self.row_index_for_offset(range.start));
        self.search_match(range)
    }

    fn search_match(&self, byte_range: Range<usize>) -> CodeEditorSearchMatch {
        CodeEditorSearchMatch {
            start: self.position_for_offset(byte_range.start),
            end: self.position_for_offset(byte_range.end),
            byte_range,
        }
    }
}

fn search_ranges(text: &str, query: &CodeEditorSearchQuery) -> Vec<Range<usize>> {
    if query.text.is_empty() {
        return Vec::new();
    }
    match query.case_sensitivity {
        CodeEditorCaseSensitivity::Sensitive => text
            .match_indices(&query.text)
            .map(|(start, matched)| start..start + matched.len())
            .collect(),
        CodeEditorCaseSensitivity::AsciiInsensitive => {
            let width = query.text.len();
            let mut ranges = Vec::new();
            let mut next_start = 0;
            for start in text.char_indices().map(|(start, _)| start) {
                if start < next_start {
                    continue;
                }
                let Some(end) = start.checked_add(width) else {
                    continue;
                };
                let Some(candidate) = text.get(start..end) else {
                    continue;
                };
                if candidate.eq_ignore_ascii_case(&query.text) {
                    ranges.push(start..end);
                    next_start = end;
                }
            }
            ranges
        }
    }
}

fn transformed_offset(offset: usize, ranges: &[Range<usize>], replacement_len: usize) -> usize {
    let mut original_cursor = 0;
    let mut transformed_cursor = 0;
    for range in ranges {
        if offset < range.start {
            return transformed_cursor + offset - original_cursor;
        }
        transformed_cursor += range.start - original_cursor;
        if offset == range.start {
            return transformed_cursor;
        }
        if offset <= range.end {
            return transformed_cursor + replacement_len;
        }
        transformed_cursor += replacement_len;
        original_cursor = range.end;
    }
    transformed_cursor + offset - original_cursor
}

#[cfg(test)]
#[path = "search_tests.rs"]
mod tests;
