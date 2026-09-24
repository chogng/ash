use std::ops::Range;
use std::sync::Arc;

use ash_diff::{DiffDocument, DiffRowKind};

use super::{DiffEditorDocument, DiffEditorSide, DiffEditorState, DiffEditorStyle, project_row};
use crate::{CodeEditorRow, CodeEditorRowSource};

const MIN_FOLDED_LINES: usize = 2;

/// Cached row-count inputs shared by every unified presentation of one immutable diff document.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct UnifiedDiffMetrics {
    collapsed_row_count: usize,
    expanded_region_extra_rows: Arc<[usize]>,
}

impl UnifiedDiffMetrics {
    pub(super) fn new(document: &DiffDocument) -> Self {
        let modified_rows = document
            .rows()
            .iter()
            .filter(|row| row.kind() == DiffRowKind::Modified)
            .count();
        let expanded_region_extra_rows = fold_regions(document)
            .into_iter()
            .map(|region| region.source_rows.len())
            .collect::<Vec<_>>();
        let fully_expanded_row_count =
            document.rows().len() + modified_rows + expanded_region_extra_rows.len();
        let collapsed_rows = expanded_region_extra_rows.iter().sum::<usize>();
        Self {
            collapsed_row_count: fully_expanded_row_count.saturating_sub(collapsed_rows),
            expanded_region_extra_rows: expanded_region_extra_rows.into(),
        }
    }

    pub(super) fn row_count(&self, state: &DiffEditorState) -> usize {
        self.collapsed_row_count
            + state
                .expanded_unchanged_regions()
                .filter_map(|index| self.expanded_region_extra_rows.get(index))
                .sum::<usize>()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct FoldRegion {
    pub(super) index: usize,
    pub(super) source_rows: Range<usize>,
}

enum UnifiedSegment {
    Source {
        source_rows: Range<usize>,
        visual_row_count: usize,
    },
    Fold {
        region: FoldRegion,
        expanded: bool,
        label: String,
    },
}

impl UnifiedSegment {
    const fn visual_row_count(&self) -> usize {
        match self {
            Self::Source {
                visual_row_count, ..
            } => *visual_row_count,
            Self::Fold { .. } => 1,
        }
    }
}

/// Compact unified projection whose size follows changed hunks rather than total file lines.
///
/// Source ranges remain symbolic. Random visual-row lookup uses the sorted list of modified source
/// rows, so scrolling a large file does not recreate one allocation per unchanged line.
pub(super) struct UnifiedDiffRows<'a> {
    document: &'a DiffEditorDocument,
    style: &'a DiffEditorStyle,
    modified_source_rows: Vec<usize>,
    segments: Vec<UnifiedSegment>,
    segment_ends: Vec<usize>,
    row_count: usize,
}

impl<'a> UnifiedDiffRows<'a> {
    pub(super) fn new(
        document: &'a DiffEditorDocument,
        state: &DiffEditorState,
        style: &'a DiffEditorStyle,
    ) -> Self {
        let modified_source_rows = document
            .diff()
            .hunks()
            .iter()
            .flat_map(|hunk| hunk.row_start()..hunk.row_end())
            .filter(|row| document.diff().rows()[*row].kind() == DiffRowKind::Modified)
            .collect::<Vec<_>>();
        let mut segments = Vec::new();
        let mut source_row = 0;
        for region in fold_regions(document.diff()) {
            append_source_segment(
                source_row..region.source_rows.start,
                &modified_source_rows,
                &mut segments,
            );
            let expanded = state.is_unchanged_region_expanded(region.index);
            let line_count = region.source_rows.len();
            segments.push(UnifiedSegment::Fold {
                region: region.clone(),
                expanded,
                label: if expanded {
                    format!("Hide {line_count} unchanged lines")
                } else {
                    format!("Show {line_count} unchanged lines")
                },
            });
            if expanded {
                append_source_segment(
                    region.source_rows.clone(),
                    &modified_source_rows,
                    &mut segments,
                );
            }
            source_row = region.source_rows.end;
        }
        append_source_segment(
            source_row..document.diff().rows().len(),
            &modified_source_rows,
            &mut segments,
        );
        let mut row_count = 0;
        let segment_ends = segments
            .iter()
            .map(|segment| {
                row_count += segment.visual_row_count();
                row_count
            })
            .collect();
        Self {
            document,
            style,
            modified_source_rows,
            segments,
            segment_ends,
            row_count,
        }
    }

    pub(super) fn side_at(&self, index: usize) -> Option<DiffEditorSide> {
        self.source_at(index).map(|(_, side)| side)
    }

    pub(super) fn fold_at(&self, index: usize) -> Option<(&FoldRegion, bool)> {
        let (segment, _) = self.segment_at(index)?;
        match segment {
            UnifiedSegment::Fold {
                region, expanded, ..
            } => Some((region, *expanded)),
            UnifiedSegment::Source { .. } => None,
        }
    }

    fn source_at(&self, index: usize) -> Option<(usize, DiffEditorSide)> {
        let (segment, offset) = self.segment_at(index)?;
        let UnifiedSegment::Source { source_rows, .. } = segment else {
            return None;
        };
        let source_row =
            source_row_at_visual_offset(source_rows.clone(), offset, &self.modified_source_rows)?;
        let before = visual_row_count(source_rows.start..source_row, &self.modified_source_rows);
        let side = match self.document.diff().rows()[source_row].kind() {
            DiffRowKind::Context | DiffRowKind::Added => DiffEditorSide::Modified,
            DiffRowKind::Removed => DiffEditorSide::Original,
            DiffRowKind::Modified if offset == before => DiffEditorSide::Original,
            DiffRowKind::Modified => DiffEditorSide::Modified,
        };
        Some((source_row, side))
    }

    fn segment_at(&self, index: usize) -> Option<(&UnifiedSegment, usize)> {
        if index >= self.row_count {
            return None;
        }
        let segment_index = self.segment_ends.partition_point(|end| *end <= index);
        let segment_start = segment_index
            .checked_sub(1)
            .map_or(0, |previous| self.segment_ends[previous]);
        Some((&self.segments[segment_index], index - segment_start))
    }
}

impl CodeEditorRowSource for UnifiedDiffRows<'_> {
    fn row_count(&self) -> usize {
        self.row_count
    }

    fn largest_line_number(&self) -> usize {
        self.document
            .diff()
            .old_line_count()
            .max(self.document.diff().new_line_count())
    }

    fn row(&self, index: usize) -> Option<CodeEditorRow<'_>> {
        let (segment, _) = self.segment_at(index)?;
        if let UnifiedSegment::Fold { label, .. } = segment {
            return Some(
                CodeEditorRow::annotation(label)
                    .with_marker("⋯", self.style.fold_marker())
                    .with_background(self.style.fold_line()),
            );
        }
        let (source_row, side) = self.source_at(index)?;
        let row = self.document.diff().rows().get(source_row)?;
        let line = match side {
            DiffEditorSide::Original => row.old(),
            DiffEditorSide::Modified => row.new_line(),
        }?;
        Some(project_row(
            row,
            side,
            self.style,
            false,
            self.document.syntax_tokens(side, line.number()),
        ))
    }
}

fn append_source_segment(
    source_rows: Range<usize>,
    modified_source_rows: &[usize],
    segments: &mut Vec<UnifiedSegment>,
) {
    if source_rows.is_empty() {
        return;
    }
    segments.push(UnifiedSegment::Source {
        visual_row_count: visual_row_count(source_rows.clone(), modified_source_rows),
        source_rows,
    });
}

fn fold_regions(document: &DiffDocument) -> Vec<FoldRegion> {
    let mut candidates = Vec::new();
    let mut previous_end = 0;
    for hunk in document.hunks() {
        if hunk.row_start().saturating_sub(previous_end) >= MIN_FOLDED_LINES {
            candidates.push(previous_end..hunk.row_start());
        }
        previous_end = hunk.row_end();
    }
    if document.rows().len().saturating_sub(previous_end) >= MIN_FOLDED_LINES {
        candidates.push(previous_end..document.rows().len());
    }
    candidates
        .into_iter()
        .enumerate()
        .map(|(index, source_rows)| FoldRegion { index, source_rows })
        .collect()
}

fn visual_row_count(source_rows: Range<usize>, modified_source_rows: &[usize]) -> usize {
    source_rows.len() + values_in_range(modified_source_rows, source_rows)
}

fn values_in_range(values: &[usize], range: Range<usize>) -> usize {
    values.partition_point(|value| *value < range.end)
        - values.partition_point(|value| *value < range.start)
}

fn source_row_at_visual_offset(
    source_rows: Range<usize>,
    visual_offset: usize,
    modified_source_rows: &[usize],
) -> Option<usize> {
    if visual_offset >= visual_row_count(source_rows.clone(), modified_source_rows) {
        return None;
    }
    let mut low = source_rows.start;
    let mut high = source_rows.end;
    while low < high {
        let middle = low + (high - low) / 2;
        let visual_end = visual_row_count(
            source_rows.start..middle.saturating_add(1),
            modified_source_rows,
        );
        if visual_end <= visual_offset {
            low = middle.saturating_add(1);
        } else {
            high = middle;
        }
    }
    (low < source_rows.end).then_some(low)
}
