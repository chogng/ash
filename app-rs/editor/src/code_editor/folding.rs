use std::collections::BTreeSet;

use zui::ui::Rect;

/// One multiline source range that can be collapsed by a CodeEditor document.
///
/// Rows are zero-based source-row indexes. The start row remains visible while collapsing hides
/// every row through and including `end_row`.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct CodeEditorFoldingRange {
    start_row: usize,
    end_row: usize,
}

impl CodeEditorFoldingRange {
    pub const fn new(start_row: usize, end_row: usize) -> Option<Self> {
        if start_row < end_row {
            Some(Self { start_row, end_row })
        } else {
            None
        }
    }

    pub const fn start_row(self) -> usize {
        self.start_row
    }

    pub const fn end_row(self) -> usize {
        self.end_row
    }

    pub const fn hidden_line_count(self) -> usize {
        self.end_row - self.start_row
    }

    pub(super) const fn hides(self, source_row: usize) -> bool {
        self.start_row < source_row && source_row <= self.end_row
    }
}

/// Whether a source folding range is visible or collapsed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CodeEditorFoldState {
    Expanded,
    Collapsed,
}

/// One visible CodeEditor gutter control and its hit-test geometry.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CodeEditorFoldControl {
    range: CodeEditorFoldingRange,
    bounds: Rect,
    state: CodeEditorFoldState,
}

impl CodeEditorFoldControl {
    pub(super) const fn new(
        range: CodeEditorFoldingRange,
        bounds: Rect,
        state: CodeEditorFoldState,
    ) -> Self {
        Self {
            range,
            bounds,
            state,
        }
    }

    pub const fn range(self) -> CodeEditorFoldingRange {
        self.range
    }

    pub const fn bounds(self) -> Rect {
        self.bounds
    }

    pub const fn state(self) -> CodeEditorFoldState {
        self.state
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(super) struct CodeEditorFoldingProjection {
    ranges: Vec<CodeEditorFoldingRange>,
    collapsed_ranges: BTreeSet<CodeEditorFoldingRange>,
    visible_rows: Vec<usize>,
}

impl CodeEditorFoldingProjection {
    pub(super) fn synchronize(
        &mut self,
        ranges: impl IntoIterator<Item = CodeEditorFoldingRange>,
        row_count: usize,
    ) {
        self.ranges = normalize_ranges(ranges, row_count);
        let ranges = &self.ranges;
        self.collapsed_ranges
            .retain(|collapsed| ranges.binary_search(collapsed).is_ok());
        self.rebuild_visible_rows(row_count);
    }

    pub(super) fn clear_state(&mut self, row_count: usize) {
        self.collapsed_ranges.clear();
        self.rebuild_visible_rows(row_count);
    }

    pub(super) fn ranges(&self) -> &[CodeEditorFoldingRange] {
        &self.ranges
    }

    pub(super) fn row_count(&self) -> usize {
        self.visible_rows.len()
    }

    pub(super) fn source_row(&self, visual_row: usize) -> Option<usize> {
        self.visible_rows.get(visual_row).copied()
    }

    pub(super) fn visual_row(&self, source_row: usize) -> Option<usize> {
        self.visible_rows.binary_search(&source_row).ok()
    }

    pub(super) fn range_starting_at(&self, source_row: usize) -> Option<CodeEditorFoldingRange> {
        self.ranges
            .binary_search_by_key(&source_row, |range| range.start_row)
            .ok()
            .map(|index| self.ranges[index])
    }

    pub(super) fn state_at(&self, source_row: usize) -> Option<CodeEditorFoldState> {
        self.range_starting_at(source_row).map(|range| {
            if self.collapsed_ranges.contains(&range) {
                CodeEditorFoldState::Collapsed
            } else {
                CodeEditorFoldState::Expanded
            }
        })
    }

    pub(super) fn collapse(&mut self, source_row: usize, row_count: usize) -> bool {
        let Some(range) = self.range_starting_at(source_row) else {
            return false;
        };
        if !self.collapsed_ranges.insert(range) {
            return false;
        }
        self.rebuild_visible_rows(row_count);
        true
    }

    pub(super) fn expand(&mut self, source_row: usize, row_count: usize) -> bool {
        let Some(range) = self.range_starting_at(source_row) else {
            return false;
        };
        if !self.collapsed_ranges.remove(&range) {
            return false;
        }
        self.rebuild_visible_rows(row_count);
        true
    }

    fn rebuild_visible_rows(&mut self, row_count: usize) {
        self.visible_rows.clear();
        self.visible_rows.reserve(row_count);
        let mut source_row = 0;
        while source_row < row_count {
            self.visible_rows.push(source_row);
            source_row = self
                .range_starting_at(source_row)
                .filter(|range| self.collapsed_ranges.contains(range))
                .map_or(source_row + 1, |range| range.end_row.saturating_add(1));
        }
    }
}

fn normalize_ranges(
    ranges: impl IntoIterator<Item = CodeEditorFoldingRange>,
    row_count: usize,
) -> Vec<CodeEditorFoldingRange> {
    let mut ranges = ranges
        .into_iter()
        .filter(|range| range.end_row < row_count)
        .collect::<Vec<_>>();
    ranges.sort_by_key(|range| (range.start_row, std::cmp::Reverse(range.end_row)));
    ranges.dedup_by_key(|range| range.start_row);
    ranges
}

#[cfg(test)]
#[path = "folding_tests.rs"]
mod tests;
