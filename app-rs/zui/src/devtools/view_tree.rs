use crate::ui::InspectionFrame;
use crate::ui::InspectionNodeId;
use crate::ui::Point;
use crate::ui::Rect;

use super::DevToolsHandle;

pub(crate) const ROW_HEIGHT: f32 = 32.0;
pub(crate) const TOOLBAR_HEIGHT: f32 = 48.0;
pub(crate) const COMPUTED_PANEL_WIDTH: f32 = 320.0;

const CONTENT_PADDING: f32 = 16.0;
const TREE_MIN_WIDTH: f32 = 240.0;
const PANEL_DIVIDER_WIDTH: f32 = 1.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TreeRow {
    pub(crate) id: InspectionNodeId,
    pub(crate) depth: usize,
    pub(crate) has_children: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TreeHit {
    Toggle(InspectionNodeId),
    Select(InspectionNodeId),
}

pub(crate) fn tree_rows(frame: &InspectionFrame, devtools: &DevToolsHandle) -> Vec<TreeRow> {
    let mut rows = Vec::with_capacity(frame.nodes().len());
    let mut visited = Vec::with_capacity(frame.nodes().len());
    for node in frame.nodes().iter().filter(|node| node.parent().is_none()) {
        append_tree_rows(frame, devtools, node.id(), 0, &mut rows, &mut visited);
    }
    for node in frame.nodes() {
        let disconnected = node
            .parent()
            .is_some_and(|parent| frame.node(parent).is_none());
        if disconnected && !visited.contains(&node.id()) {
            append_tree_rows(frame, devtools, node.id(), 0, &mut rows, &mut visited);
        }
    }
    if rows.is_empty() {
        for node in frame.nodes() {
            if !visited.contains(&node.id()) {
                append_tree_rows(frame, devtools, node.id(), 0, &mut rows, &mut visited);
            }
        }
    }
    rows
}

pub(crate) fn tree_hit_at(
    bounds: Rect,
    point: Point,
    frame: &InspectionFrame,
    devtools: &DevToolsHandle,
) -> Option<TreeHit> {
    let content = Rect::from_xywh(
        bounds.origin.x,
        bounds.origin.y + TOOLBAR_HEIGHT,
        bounds.size.width,
        (bounds.size.height - TOOLBAR_HEIGHT).max(0.0),
    );
    let tree = tree_bounds(content);
    if !tree.contains(point) {
        return None;
    }
    let rows = tree_rows(frame, devtools);
    let scroll = clamped_scroll(devtools.scroll_offset(), rows.len(), tree.size.height);
    let index = ((point.y - tree.origin.y + scroll) / ROW_HEIGHT).floor() as usize;
    let row = rows.get(index)?;
    let row_bounds = Rect::from_xywh(
        tree.origin.x,
        tree.origin.y + index as f32 * ROW_HEIGHT - scroll,
        tree.size.width,
        ROW_HEIGHT,
    );
    let disclosure = disclosure_bounds(row_bounds, row.depth);
    if row.has_children && disclosure.contains(point) {
        Some(TreeHit::Toggle(row.id))
    } else {
        Some(TreeHit::Select(row.id))
    }
}

pub(crate) fn tree_bounds(content: Rect) -> Rect {
    split_bounds(content).0
}

pub(crate) fn computed_bounds(content: Rect) -> Rect {
    split_bounds(content).1
}

pub(crate) fn clamped_scroll(offset: f32, row_count: usize, viewport_height: f32) -> f32 {
    let max_scroll = (row_count as f32 * ROW_HEIGHT - viewport_height).max(0.0);
    offset.max(0.0).min(max_scroll)
}

fn append_tree_rows(
    frame: &InspectionFrame,
    devtools: &DevToolsHandle,
    id: InspectionNodeId,
    depth: usize,
    rows: &mut Vec<TreeRow>,
    visited: &mut Vec<InspectionNodeId>,
) {
    if visited.contains(&id) {
        return;
    }
    visited.push(id);
    let has_children = frame.nodes().iter().any(|node| node.parent() == Some(id));
    rows.push(TreeRow {
        id,
        depth,
        has_children,
    });
    if !has_children || devtools.is_collapsed(id) {
        return;
    }
    for child in frame
        .nodes()
        .iter()
        .filter(|node| node.parent() == Some(id))
    {
        append_tree_rows(frame, devtools, child.id(), depth + 1, rows, visited);
    }
}

fn disclosure_bounds(row: Rect, depth: usize) -> Rect {
    let x = row.origin.x + CONTENT_PADDING + depth as f32 * 12.0;
    Rect::from_xywh(x, row.origin.y + 4.0, 18.0, 20.0)
}

fn split_bounds(content: Rect) -> (Rect, Rect) {
    let divider = PANEL_DIVIDER_WIDTH.min(content.size.width.max(0.0));
    let available = (content.size.width - divider).max(0.0);
    let computed_width = if available >= TREE_MIN_WIDTH + COMPUTED_PANEL_WIDTH {
        COMPUTED_PANEL_WIDTH
    } else {
        (available * 0.42).max(0.0).min(available)
    };
    let tree_width = (available - computed_width).max(0.0);
    let tree = Rect::from_xywh(
        content.origin.x,
        content.origin.y,
        tree_width,
        content.size.height,
    );
    let computed = Rect::from_xywh(
        tree.right() + divider,
        content.origin.y,
        computed_width,
        content.size.height,
    );
    (tree, computed)
}
