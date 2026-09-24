//! Fixed- and variable-extent virtual list geometry composed with the shared ScrollView.

use std::ops::Range;

use crate::{
    Point, Rect, ScrollAxis, ScrollCommand, ScrollState, ScrollView, ScrollViewStyle,
    ScrollViewport, ScrollbarPresentation, Size, UiScene,
};

#[path = "anchor.rs"]
mod anchor;
#[path = "extent_index.rs"]
mod extent_index;
#[path = "extent_overrides.rs"]
mod extent_overrides;
#[path = "extent_tree.rs"]
mod extent_tree;

pub use anchor::ListScrollAnchor;
use extent_index::ListItemExtents;
use extent_overrides::ListItemExtentOverrides;

/// Geometry for one projected list item.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ListItemLayout {
    index: usize,
    bounds: Rect,
}

impl ListItemLayout {
    pub const fn index(self) -> usize {
        self.index
    }

    pub const fn bounds(self) -> Rect {
        self.bounds
    }
}

/// Leading and trailing space around the list's item sequence.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ListContentPadding {
    before: f32,
    after: f32,
}

impl ListContentPadding {
    pub fn new(before: f32, after: f32) -> Self {
        assert_non_negative_finite(before, "List leading padding");
        assert_non_negative_finite(after, "List trailing padding");
        Self { before, after }
    }

    pub fn symmetric(value: f32) -> Self {
        Self::new(value, value)
    }

    pub const fn before(self) -> f32 {
        self.before
    }

    pub const fn after(self) -> f32 {
        self.after
    }
}

/// Platform-independent list measurement and viewport projection.
///
/// Fixed extents use direct arithmetic. Variable extents retain a cumulative-height index so
/// visible ranges, hit testing, and item geometry remain logarithmic in the number of items. This type
/// owns no item content or selection; consumers retain stable identity and domain semantics.
#[derive(Clone, Debug, PartialEq)]
pub struct VirtualListLayout {
    item_extents: ListItemExtents,
    extent_overrides: ListItemExtentOverrides,
    item_gap: f32,
    content_padding: ListContentPadding,
    overscan_items: usize,
}

impl VirtualListLayout {
    /// Creates a fixed-extent layout without allocating per-item geometry.
    pub fn new(item_count: usize, item_extent: f32) -> Self {
        assert_positive_finite(item_extent, "List item extent");
        Self {
            item_extents: ListItemExtents::fixed(item_count, item_extent),
            extent_overrides: ListItemExtentOverrides::default(),
            item_gap: 0.0,
            content_padding: ListContentPadding::default(),
            overscan_items: 0,
        }
    }

    /// Creates a variable-extent layout and builds its cumulative-height index.
    pub fn variable(item_extents: impl IntoIterator<Item = f32>) -> Self {
        let item_extents = item_extents.into_iter().collect::<Vec<_>>();
        for &extent in &item_extents {
            assert_positive_finite(extent, "Variable list item extent");
        }
        Self {
            item_extents: ListItemExtents::variable(item_extents),
            extent_overrides: ListItemExtentOverrides::default(),
            item_gap: 0.0,
            content_padding: ListContentPadding::default(),
            overscan_items: 0,
        }
    }

    pub fn with_item_gap(mut self, item_gap: f32) -> Self {
        assert_non_negative_finite(item_gap, "List item gap");
        self.item_gap = item_gap;
        self
    }

    pub const fn with_content_padding(mut self, content_padding: ListContentPadding) -> Self {
        self.content_padding = content_padding;
        self
    }

    pub const fn with_overscan_items(mut self, overscan_items: usize) -> Self {
        self.overscan_items = overscan_items;
        self
    }

    /// Applies a small set of temporary item extents without copying the retained extent index.
    ///
    /// This is intended for presentation-time changes such as the handful of rows currently
    /// animating. Indices must be unique; out-of-range indices are rejected.
    pub fn with_item_extent_overrides(
        mut self,
        overrides: impl IntoIterator<Item = (usize, f32)>,
    ) -> Self {
        self.extent_overrides = ListItemExtentOverrides::new(&self.item_extents, overrides);
        self
    }

    pub fn item_count(&self) -> usize {
        self.item_extents.item_count()
    }

    pub fn item_extent(&self, index: usize) -> Option<f32> {
        self.extent_overrides
            .item_extent(index)
            .or_else(|| self.item_extents.item_extent(index))
    }

    /// Copies the current item extents in index order for collection snapshot reconciliation.
    pub fn item_extents(&self) -> Vec<f32> {
        let mut extents = self.item_extents.extents();
        for (index, extent) in extents.iter_mut().enumerate() {
            if let Some(overridden) = self.extent_overrides.item_extent(index) {
                *extent = overridden;
            }
        }
        extents
    }

    /// Updates one measured item extent in the cached cumulative index.
    ///
    /// A fixed layout becomes variable when its first item-specific measurement is recorded. The
    /// returned value is the previous extent, or `None` when `index` is outside the layout.
    pub fn update_item_extent(&mut self, index: usize, item_extent: f32) -> Option<f32> {
        assert_positive_finite(item_extent, "List item extent");
        let previous = self.item_extent(index)?;
        if previous == item_extent {
            return Some(previous);
        }
        self.extent_overrides.remove(index, &self.item_extents);
        self.item_extents.update(index, item_extent);
        Some(previous)
    }

    /// Replaces one contiguous item range while retaining unrelated extent-tree branches.
    ///
    /// This is the incremental collection operation used when a flattened tree expands, collapses,
    /// or refreshes one child range. The range must be ordered and within the current item count.
    pub fn splice_item_extents(
        &mut self,
        range: Range<usize>,
        replacements: impl IntoIterator<Item = f32>,
    ) {
        assert!(
            range.start <= range.end && range.end <= self.item_count(),
            "List item extent splice range must be ordered and in bounds"
        );
        let replacements = replacements.into_iter().collect::<Vec<_>>();
        for &extent in &replacements {
            assert_positive_finite(extent, "Variable list item extent");
        }
        let inserted_count = replacements.len();
        self.item_extents.splice(range.clone(), replacements);
        self.extent_overrides
            .splice(range, inserted_count, &self.item_extents);
    }

    pub fn content_extent(&self) -> f32 {
        let item_count = self.item_count();
        let items_extent =
            self.item_extents.total_extent() + self.extent_overrides.delta_before(item_count);
        let content_extent = self.content_padding.before
            + items_extent
            + item_count.saturating_sub(1) as f32 * self.item_gap
            + self.content_padding.after;
        assert!(
            content_extent.is_finite(),
            "List content extent must be finite"
        );
        content_extent
    }

    pub fn content_size(&self, width: f32) -> Size {
        assert_non_negative_finite(width, "List content width");
        Size::new(width, self.content_extent())
    }

    pub fn visible_range(&self, viewport: ScrollViewport) -> Range<usize> {
        self.range_for_content_bounds(viewport.visible_content_bounds(), 0)
    }

    pub fn projected_range(&self, viewport: ScrollViewport) -> Range<usize> {
        self.range_for_content_bounds(viewport.visible_content_bounds(), self.overscan_items)
    }

    pub fn item_bounds(&self, index: usize, viewport: ScrollViewport) -> Option<Rect> {
        Some(Rect::from_xywh(
            viewport.content_origin().x,
            viewport.content_origin().y + self.item_start(index)?,
            viewport.bounds().size.width,
            self.item_extent(index)?,
        ))
    }

    pub fn item_at(&self, point: Point, viewport: ScrollViewport) -> Option<usize> {
        if !viewport.bounds().contains(point) {
            return None;
        }
        let content_y = point.y - viewport.content_origin().y;
        let index = self.first_item_ending_after(content_y);
        if index >= self.item_count() || content_y < self.item_start(index)? {
            return None;
        }
        Some(index)
    }

    pub fn ensure_visible_command(&self, index: usize, width: f32) -> Option<ScrollCommand> {
        assert_non_negative_finite(width, "List item width");
        Some(ScrollCommand::EnsureVisible(Rect::from_xywh(
            0.0,
            self.item_start(index)?,
            width,
            self.item_extent(index)?,
        )))
    }

    /// Captures the first item intersecting a vertical viewport offset.
    pub fn scroll_anchor(&self, scroll_offset: f32) -> Option<ListScrollAnchor> {
        assert_non_negative_finite(scroll_offset, "List scroll offset");
        let item_count = self.item_count();
        if item_count == 0 {
            return None;
        }
        let item_index = self
            .first_item_ending_after(scroll_offset)
            .min(item_count - 1);
        Some(ListScrollAnchor {
            item_index,
            distance_from_item_start: scroll_offset - self.item_start(item_index)?,
        })
    }

    /// Restores a captured item-relative viewport position after measurements or order change.
    pub fn command_for_anchor(&self, anchor: ListScrollAnchor) -> Option<ScrollCommand> {
        let offset =
            (self.item_start(anchor.item_index)? + anchor.distance_from_item_start).max(0.0);
        Some(ScrollCommand::ToOffset(Point::new(0.0, offset)))
    }

    fn item_start(&self, index: usize) -> Option<f32> {
        if index >= self.item_count() {
            return None;
        }
        let preceding_extent =
            self.item_extents.extent_before(index)? + self.extent_overrides.delta_before(index);
        Some(self.content_padding.before + preceding_extent + index as f32 * self.item_gap)
    }

    fn item_end(&self, index: usize) -> Option<f32> {
        Some(self.item_start(index)? + self.item_extent(index)?)
    }

    fn range_for_content_bounds(&self, bounds: Rect, overscan: usize) -> Range<usize> {
        if self.item_count() == 0 || bounds.is_empty() {
            return 0..0;
        }
        let first = self.first_item_ending_after(bounds.origin.y);
        let end = self.first_item_starting_at_or_after(bounds.bottom());
        first.saturating_sub(overscan).min(self.item_count())
            ..end.saturating_add(overscan).min(self.item_count())
    }

    fn first_item_ending_after(&self, coordinate: f32) -> usize {
        if self.extent_overrides.is_empty() {
            return self
                .item_extents
                .first_item_ending_after(coordinate - self.content_padding.before, self.item_gap);
        }
        self.partition_items(|index| {
            self.item_end(index)
                .is_some_and(|item_end| item_end <= coordinate)
        })
    }

    fn first_item_starting_at_or_after(&self, coordinate: f32) -> usize {
        if self.extent_overrides.is_empty() {
            return self.item_extents.first_item_starting_at_or_after(
                coordinate - self.content_padding.before,
                self.item_gap,
            );
        }
        self.partition_items(|index| {
            self.item_start(index)
                .is_some_and(|item_start| item_start < coordinate)
        })
    }

    fn partition_items(&self, is_before_boundary: impl Fn(usize) -> bool) -> usize {
        let mut left = 0;
        let mut right = self.item_count();
        while left < right {
            let middle = left + (right - left) / 2;
            if is_before_boundary(middle) {
                left = middle + 1;
            } else {
                right = middle;
            }
        }
        left
    }
}

/// Virtual list composed from [`VirtualListLayout`] and [`ScrollView`].
///
/// The host owns retained [`ScrollState`], platform input routing, item identity, interaction
/// semantics, and item paint. ListView owns content extent, visible-range projection, translated
/// item bounds, clipping, and scrollbar presentation.
#[derive(Clone, Debug, PartialEq)]
pub struct ListView {
    layout: VirtualListLayout,
    scroll_view: ScrollView,
}

impl ListView {
    pub fn new(
        bounds: Rect,
        item_count: usize,
        item_extent: f32,
        state: ScrollState,
        style: ScrollViewStyle,
    ) -> Self {
        Self::from_layout(
            bounds,
            VirtualListLayout::new(item_count, item_extent),
            state,
            style,
        )
    }

    pub fn from_layout(
        bounds: Rect,
        layout: VirtualListLayout,
        state: ScrollState,
        style: ScrollViewStyle,
    ) -> Self {
        let scroll_view = ScrollView::new(
            bounds,
            layout.content_size(bounds.size.width),
            state,
            ScrollAxis::Vertical,
            style,
        );
        Self {
            layout,
            scroll_view,
        }
    }

    pub fn with_overscan_items(mut self, overscan_items: usize) -> Self {
        self.layout = self.layout.with_overscan_items(overscan_items);
        self
    }

    pub fn with_scrollbar_presentation(mut self, presentation: ScrollbarPresentation) -> Self {
        self.scroll_view = self.scroll_view.with_scrollbar_presentation(presentation);
        self
    }

    pub const fn layout(&self) -> &VirtualListLayout {
        &self.layout
    }

    pub const fn scroll_view(&self) -> ScrollView {
        self.scroll_view
    }

    pub fn visible_range(&self) -> Range<usize> {
        self.layout.visible_range(self.scroll_view.viewport())
    }

    pub fn item_bounds(&self, index: usize) -> Option<Rect> {
        self.layout.item_bounds(index, self.scroll_view.viewport())
    }

    pub fn item_at(&self, point: Point) -> Option<usize> {
        self.layout.item_at(point, self.scroll_view.viewport())
    }

    pub fn ensure_visible_command(&self, index: usize) -> Option<ScrollCommand> {
        self.layout
            .ensure_visible_command(index, self.scroll_view.bounds().size.width)
    }

    pub fn scroll_anchor(&self) -> Option<ListScrollAnchor> {
        self.layout.scroll_anchor(
            self.scroll_view
                .viewport()
                .visible_content_bounds()
                .origin
                .y,
        )
    }

    pub fn draw(
        &self,
        scene: &mut UiScene,
        mut draw_item: impl FnMut(&mut UiScene, ListItemLayout),
    ) {
        self.scroll_view.draw(scene, |scene, viewport| {
            for index in self.layout.projected_range(viewport) {
                let bounds = self
                    .layout
                    .item_bounds(index, viewport)
                    .expect("projected list item");
                draw_item(scene, ListItemLayout { index, bounds });
            }
        });
    }

    /// Composes visible list items through the shared component frame while retaining clipping,
    /// translated bounds, and scrollbar paint.
    pub fn draw_components(
        &self,
        context: &mut crate::ComponentContext<'_, '_>,
        mut draw_item: impl FnMut(&mut crate::ComponentContext<'_, '_>, ListItemLayout),
    ) {
        self.scroll_view
            .draw_components(context, |context, viewport| {
                for index in self.layout.projected_range(viewport) {
                    let bounds = self
                        .layout
                        .item_bounds(index, viewport)
                        .expect("projected list item");
                    draw_item(context, ListItemLayout { index, bounds });
                }
            });
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
#[path = "list_view_tests.rs"]
mod tests;
