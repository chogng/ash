//! One transcript geometry result serves drawing, scrolling and pointer targets.

use super::ChatHistoryScroll;
use super::TranscriptScrollAnchor;
use super::TranscriptScrollDirection;
use super::TranscriptScrollTarget;
use crate::thread::transcript::CellView;
use crate::thread::transcript::history_cell::CellLayout;
use ratatui::layout::Rect;
use unicode_width::UnicodeWidthStr;

pub(super) struct TranscriptLayout {
    pub(super) cells: Vec<CellLayout>,
    pub(super) header_rows: usize,
    pub(super) content: Rect,
    pub(super) viewport_start: usize,
    pub(super) jump: Option<Rect>,
    bottom_offset: usize,
    anchored: bool,
}

impl TranscriptLayout {
    pub(super) fn new(
        area: Rect,
        header_rows: usize,
        messages: &[CellView<'_>],
        scroll: &ChatHistoryScroll,
        cells: Vec<CellLayout>,
        jump_label: &str,
    ) -> Self {
        let total_rows =
            header_rows.saturating_add(cells.iter().map(|cell| cell.height).sum::<usize>());
        let anchored = scroll.anchor().is_some();
        let jump = (area.width > 0
            && area.height > 0
            && total_rows > usize::from(area.height)
            && anchored)
            .then(|| Rect::new(area.x, area.bottom() - 1, area.width, 1));
        let content = Rect::new(
            area.x,
            area.y,
            area.width,
            area.height.saturating_sub(u16::from(jump.is_some())),
        );
        let bottom_offset = total_rows.saturating_sub(usize::from(content.height));
        let viewport_start = viewport_offset(messages, header_rows, &cells, scroll, bottom_offset);
        let jump = jump.map(|mut target| {
            let width = jump_label.width().min(usize::from(area.width)) as u16;
            target.x = area.x + (area.width - width) / 2;
            target.width = width;
            target
        });
        Self {
            cells,
            header_rows,
            content,
            viewport_start,
            jump,
            bottom_offset,
            anchored,
        }
    }

    pub(super) fn scroll_target(
        &self,
        messages: &[CellView<'_>],
        direction: TranscriptScrollDirection,
        rows: usize,
    ) -> Option<TranscriptScrollTarget> {
        let target = match direction {
            TranscriptScrollDirection::Up => self.viewport_start.saturating_sub(rows),
            TranscriptScrollDirection::Down => self.viewport_start.saturating_add(rows),
        };
        if target >= self.bottom_offset {
            return self
                .anchored
                .then_some(TranscriptScrollTarget::FollowLatest);
        }
        if target == self.viewport_start {
            return None;
        }
        anchor_at(messages, self.header_rows, &self.cells, target)
            .map(TranscriptScrollTarget::Anchor)
    }
}

fn viewport_offset(
    messages: &[CellView<'_>],
    header_rows: usize,
    heights: &[CellLayout],
    scroll: &ChatHistoryScroll,
    bottom_offset: usize,
) -> usize {
    let Some(anchor) = scroll.anchor() else {
        return bottom_offset;
    };
    if let TranscriptScrollAnchor::Header { line_offset } = anchor {
        return (*line_offset)
            .min(header_rows.saturating_sub(1))
            .min(bottom_offset);
    }
    let TranscriptScrollAnchor::Cell {
        cell_id,
        line_offset,
    } = anchor
    else {
        unreachable!();
    };
    let mut start = header_rows;
    for (cell, layout) in messages.iter().zip(heights) {
        let height = layout.height;
        if cell.cell_id.as_deref() == Some(cell_id.as_str()) {
            return start
                .saturating_add((*line_offset).min(height.saturating_sub(1)))
                .min(bottom_offset);
        }
        start = start.saturating_add(height);
    }
    bottom_offset
}

fn anchor_at(
    messages: &[CellView<'_>],
    header_rows: usize,
    heights: &[CellLayout],
    target: usize,
) -> Option<TranscriptScrollAnchor> {
    if target < header_rows {
        return Some(TranscriptScrollAnchor::Header {
            line_offset: target,
        });
    }
    let mut start = header_rows;
    for (index, (cell, layout)) in messages.iter().zip(heights).enumerate() {
        let height = layout.height;
        let end = start.saturating_add(height);
        if target < end {
            let line_offset = target.saturating_sub(start);
            if line_offset == height.saturating_sub(1)
                && let Some(cell_id) = messages
                    .get(index.saturating_add(1))
                    .and_then(|cell| cell.cell_id.as_ref())
            {
                return Some(TranscriptScrollAnchor::Cell {
                    cell_id: cell_id.clone(),
                    line_offset: 0,
                });
            }
            return cell
                .cell_id
                .as_ref()
                .map(|cell_id| TranscriptScrollAnchor::Cell {
                    cell_id: cell_id.clone(),
                    line_offset: line_offset.min(height.saturating_sub(2)),
                });
        }
        start = end;
    }
    None
}
