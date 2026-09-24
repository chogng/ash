//! Virtualized fixed- and variable-extent tree geometry built on the shared ListView.

use std::ops::Range;

use crate::{
    ListScrollAnchor, ListView, Point, Rect, ScrollCommand, ScrollState, ScrollView,
    ScrollViewStyle, UiScene, VirtualListLayout,
};

/// Expansion semantics projected by one visible tree item.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TreeItemExpansion {
    Leaf,
    Collapsed,
    Expanded,
}

impl TreeItemExpansion {
    pub const fn is_branch(self) -> bool {
        matches!(self, Self::Collapsed | Self::Expanded)
    }
}

/// Structural state for one item in the host-flattened visible tree sequence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TreeItem {
    depth: usize,
    expansion: TreeItemExpansion,
}

impl TreeItem {
    pub const fn new(depth: usize, expansion: TreeItemExpansion) -> Self {
        Self { depth, expansion }
    }

    pub const fn depth(self) -> usize {
        self.depth
    }

    pub const fn expansion(self) -> TreeItemExpansion {
        self.expansion
    }
}

/// Component-owned default row, indentation, and disclosure geometry.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TreeViewStyle {
    scroll_view: ScrollViewStyle,
    row_extent: f32,
    indentation: f32,
    disclosure_extent: f32,
    content_gap: f32,
}

impl TreeViewStyle {
    pub fn new(scroll_view: ScrollViewStyle, row_extent: f32) -> Self {
        assert_positive_finite(row_extent, "Tree row extent");
        Self {
            scroll_view,
            row_extent,
            indentation: 12.0,
            disclosure_extent: 16.0,
            content_gap: 4.0,
        }
    }

    pub fn with_indentation(mut self, indentation: f32) -> Self {
        assert_non_negative_finite(indentation, "Tree indentation");
        self.indentation = indentation;
        self
    }

    pub fn with_disclosure_extent(mut self, disclosure_extent: f32) -> Self {
        assert_non_negative_finite(disclosure_extent, "Tree disclosure extent");
        self.disclosure_extent = disclosure_extent;
        self
    }

    pub fn with_content_gap(mut self, content_gap: f32) -> Self {
        assert_non_negative_finite(content_gap, "Tree content gap");
        self.content_gap = content_gap;
        self
    }

    pub const fn row_extent(self) -> f32 {
        self.row_extent
    }
}

/// Geometry for one projected visible tree item.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TreeItemLayout {
    index: usize,
    bounds: Rect,
    disclosure_bounds: Option<Rect>,
    content_bounds: Rect,
    item: TreeItem,
}

impl TreeItemLayout {
    pub const fn index(self) -> usize {
        self.index
    }

    pub const fn bounds(self) -> Rect {
        self.bounds
    }

    pub const fn disclosure_bounds(self) -> Option<Rect> {
        self.disclosure_bounds
    }

    pub const fn content_bounds(self) -> Rect {
        self.content_bounds
    }

    pub const fn item(self) -> TreeItem {
        self.item
    }
}

/// Virtual tree surface over a host-owned flattened visible node sequence.
///
/// The host owns hierarchy, stable node identity, expansion state, selection, and child loading.
/// TreeView composes ListView to own row virtualization, depth indentation, disclosure geometry,
/// clipping, point hit-testing, and scrollbar presentation.
pub struct TreeView<'a> {
    items: &'a [TreeItem],
    list: ListView,
    style: TreeViewStyle,
}

impl<'a> TreeView<'a> {
    pub fn new(
        bounds: Rect,
        items: &'a [TreeItem],
        state: ScrollState,
        style: TreeViewStyle,
    ) -> Self {
        Self {
            items,
            list: ListView::new(
                bounds,
                items.len(),
                style.row_extent,
                state,
                style.scroll_view,
            ),
            style,
        }
    }

    /// Creates a tree over retained variable item geometry.
    ///
    /// The host keeps `layout` synchronized with its flattened visible-node sequence and uses
    /// [`VirtualListLayout::splice_item_extents`] for subtree expansion and collapse.
    pub fn from_layout(
        bounds: Rect,
        items: &'a [TreeItem],
        layout: VirtualListLayout,
        state: ScrollState,
        style: TreeViewStyle,
    ) -> Self {
        assert_eq!(
            items.len(),
            layout.item_count(),
            "Tree items and retained list layout must have the same length"
        );
        Self {
            items,
            list: ListView::from_layout(bounds, layout, state, style.scroll_view),
            style,
        }
    }

    pub fn with_overscan_items(mut self, overscan_items: usize) -> Self {
        self.list = self.list.with_overscan_items(overscan_items);
        self
    }

    pub fn visible_range(&self) -> Range<usize> {
        self.list.visible_range()
    }

    pub const fn scroll_view(&self) -> ScrollView {
        self.list.scroll_view()
    }

    pub const fn layout(&self) -> &VirtualListLayout {
        self.list.layout()
    }

    pub fn scroll_anchor(&self) -> Option<ListScrollAnchor> {
        self.list.scroll_anchor()
    }

    pub fn item_layout(&self, index: usize) -> Option<TreeItemLayout> {
        self.layout_item(index, self.list.item_bounds(index)?)
    }

    pub fn item_at(&self, point: Point) -> Option<usize> {
        self.list.item_at(point)
    }

    pub fn disclosure_at(&self, point: Point) -> Option<usize> {
        let index = self.item_at(point)?;
        self.item_layout(index)?
            .disclosure_bounds
            .is_some_and(|bounds| bounds.contains(point))
            .then_some(index)
    }

    pub fn ensure_visible_command(&self, index: usize) -> Option<ScrollCommand> {
        self.list.ensure_visible_command(index)
    }

    pub fn draw(
        &self,
        scene: &mut UiScene,
        mut draw_item: impl FnMut(&mut UiScene, TreeItemLayout),
    ) {
        self.list.draw(scene, |scene, list_item| {
            draw_item(
                scene,
                self.layout_item(list_item.index(), list_item.bounds())
                    .expect("projected tree item"),
            );
        });
    }

    /// Composes visible tree items through the shared component frame while retaining scroll
    /// clipping, translated row bounds, and scrollbar paint.
    pub fn draw_components(
        &self,
        context: &mut crate::ComponentContext<'_, '_>,
        mut draw_item: impl FnMut(&mut crate::ComponentContext<'_, '_>, TreeItemLayout),
    ) {
        self.list.draw_components(context, |context, list_item| {
            draw_item(
                context,
                self.layout_item(list_item.index(), list_item.bounds())
                    .expect("projected tree item"),
            );
        });
    }

    fn layout_item(&self, index: usize, bounds: Rect) -> Option<TreeItemLayout> {
        let item = *self.items.get(index)?;
        let indentation = item.depth as f32 * self.style.indentation;
        let disclosure_x = bounds.origin.x + indentation;
        let disclosure_bounds = item.expansion.is_branch().then(|| {
            Rect::from_xywh(
                disclosure_x,
                bounds.origin.y + (bounds.size.height - self.style.disclosure_extent) * 0.5,
                self.style.disclosure_extent,
                self.style.disclosure_extent,
            )
        });
        let content_x = disclosure_x + self.style.disclosure_extent + self.style.content_gap;
        Some(TreeItemLayout {
            index,
            bounds,
            disclosure_bounds,
            content_bounds: Rect::from_xywh(
                content_x,
                bounds.origin.y,
                (bounds.right() - content_x).max(0.0),
                bounds.size.height,
            ),
            item,
        })
    }
}

fn assert_positive_finite(value: f32, label: &str) {
    assert!(
        value.is_finite() && value > 0.0,
        "{label} must be positive and finite"
    );
}

fn assert_non_negative_finite(value: f32, label: &str) {
    assert!(
        value.is_finite() && value >= 0.0,
        "{label} must be non-negative and finite"
    );
}

#[cfg(test)]
#[path = "tree_view_tests.rs"]
mod tests;
