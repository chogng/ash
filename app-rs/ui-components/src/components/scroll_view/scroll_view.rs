use crate::Component;
use crate::ComponentContext;
use crate::ComponentElement;
use crate::Element;
use crate::HorizontalScrollbar;
use crate::Point;
use crate::Rect;
use crate::ScrollbarAxis;
use crate::ScrollbarDrag;
use crate::ScrollbarHit;
use crate::ScrollbarMetrics;
use crate::ScrollbarPresentation;
use crate::ScrollbarStyle;
use crate::Size;
use crate::UiScene;
use crate::VerticalScrollbar;

mod state;

pub use state::ScrollAxis;
pub use state::ScrollCommand;
pub use state::ScrollDelta;
pub use state::ScrollMetrics;
pub use state::ScrollState;
use state::assert_rect;
use state::assert_size;

/// Policy for painting scrollbars owned by one [`ScrollView`].
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum ScrollbarVisibility {
    Hidden,
    Always,
    #[default]
    Automatic,
}

/// Scrollbar style and visibility policy for a [`ScrollView`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollViewStyle {
    scrollbar: ScrollbarStyle,
    visibility: ScrollbarVisibility,
}

impl ScrollViewStyle {
    pub const fn new(scrollbar: ScrollbarStyle) -> Self {
        Self {
            scrollbar,
            visibility: ScrollbarVisibility::Automatic,
        }
    }

    pub const fn with_visibility(mut self, visibility: ScrollbarVisibility) -> Self {
        self.visibility = visibility;
        self
    }
}

/// Geometry passed to arbitrary content hosted by [`ScrollView::draw`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollViewport {
    bounds: Rect,
    content_origin: Point,
    visible_content_bounds: Rect,
}

impl ScrollViewport {
    pub const fn bounds(self) -> Rect {
        self.bounds
    }

    pub const fn content_origin(self) -> Point {
        self.content_origin
    }

    pub const fn visible_content_bounds(self) -> Rect {
        self.visible_content_bounds
    }
}

/// Clipping viewport that composes one independent scrollbar per enabled axis.
///
/// The host retains [`ScrollState`], normalizes platform input into [`ScrollCommand`], and computes
/// content size. [`crate::ScrollbarController`] owns reusable hover, visibility, and capture while
/// ScrollView owns effective offset clamping, content translation, clipping, visibility policy,
/// and axis composition.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollView {
    bounds: Rect,
    content_size: Size,
    state: ScrollState,
    axis: ScrollAxis,
    style: ScrollViewStyle,
    scrollbar_presentation: ScrollbarPresentation,
}

impl ScrollView {
    pub fn new(
        bounds: Rect,
        content_size: Size,
        state: ScrollState,
        axis: ScrollAxis,
        style: ScrollViewStyle,
    ) -> Self {
        assert_rect(bounds);
        assert_size(content_size, "Scroll content");
        Self {
            bounds,
            content_size,
            state,
            axis,
            style,
            scrollbar_presentation: ScrollbarPresentation::default(),
        }
    }

    pub const fn with_scrollbar_presentation(
        mut self,
        presentation: ScrollbarPresentation,
    ) -> Self {
        self.scrollbar_presentation = presentation;
        self
    }

    pub const fn bounds(&self) -> Rect {
        self.bounds
    }

    pub fn metrics(&self) -> ScrollMetrics {
        ScrollMetrics::new(self.bounds.size, self.content_size)
    }

    pub fn viewport(&self) -> ScrollViewport {
        let offset = self.effective_offset();
        ScrollViewport {
            bounds: self.bounds,
            content_origin: Point::new(
                self.bounds.origin.x - offset.x,
                self.bounds.origin.y - offset.y,
            ),
            visible_content_bounds: Rect::from_xywh(
                offset.x,
                offset.y,
                self.bounds.size.width,
                self.bounds.size.height,
            ),
        }
    }

    pub fn vertical_scrollbar(&self) -> Option<VerticalScrollbar> {
        if !self.axis.permits_vertical() {
            return None;
        }
        let metrics = ScrollbarMetrics::new(
            self.bounds.size.height,
            self.content_size.height,
            self.effective_offset().y,
        );
        self.scrollbar_visible(metrics).then(|| {
            VerticalScrollbar::new(self.bounds, metrics, self.style.scrollbar)
                .with_presentation(self.scrollbar_presentation)
        })
    }

    pub fn horizontal_scrollbar(&self) -> Option<HorizontalScrollbar> {
        if !self.axis.permits_horizontal() {
            return None;
        }
        let metrics = ScrollbarMetrics::new(
            self.bounds.size.width,
            self.content_size.width,
            self.effective_offset().x,
        );
        self.scrollbar_visible(metrics).then(|| {
            HorizontalScrollbar::new(self.bounds, metrics, self.style.scrollbar)
                .with_presentation(self.scrollbar_presentation)
        })
    }

    /// Resolves whether a point lies over a thumb or the remainder of its track.
    pub fn hit_test_scrollbar(&self, point: Point) -> Option<ScrollbarHit> {
        if let Some(hit) = self
            .vertical_scrollbar()
            .and_then(|scrollbar| scrollbar.hit_test(point))
        {
            return Some(hit);
        }
        self.horizontal_scrollbar()
            .and_then(|scrollbar| scrollbar.hit_test(point))
    }

    /// Captures the pointer-to-thumb relationship used throughout a drag.
    pub fn begin_scrollbar_drag(&self, hit: ScrollbarHit, point: Point) -> Option<ScrollbarDrag> {
        match hit.axis() {
            ScrollbarAxis::Horizontal => {
                self.horizontal_scrollbar()?
                    .begin_drag(hit, point, self.effective_offset())
            }
            ScrollbarAxis::Vertical => {
                self.vertical_scrollbar()?
                    .begin_drag(hit, point, self.effective_offset())
            }
        }
    }

    /// Returns a one-viewport page command for a click before or after the thumb.
    pub fn track_click_command(&self, hit: ScrollbarHit, point: Point) -> Option<ScrollCommand> {
        match hit.axis() {
            ScrollbarAxis::Horizontal => {
                self.horizontal_scrollbar()?.track_click_command(hit, point)
            }
            ScrollbarAxis::Vertical => self.vertical_scrollbar()?.track_click_command(hit, point),
        }
    }

    /// Clips arbitrary content to the viewport, then paints composed scrollbars above it.
    pub fn draw<R>(
        &self,
        scene: &mut UiScene,
        draw_content: impl FnOnce(&mut UiScene, ScrollViewport) -> R,
    ) -> R {
        scene.with_element(self.element_tree(), |scene, _element| {
            let result = scene.with_clip(self.bounds, |scene| draw_content(scene, self.viewport()));
            self.paint(scene);
            result
        })
    }

    /// Composes scroll content and one component node for each visible scrollbar.
    pub fn draw_components<R>(
        &self,
        context: &mut ComponentContext<'_, '_>,
        draw_content: impl FnOnce(&mut ComponentContext<'_, '_>, ScrollViewport) -> R,
    ) -> R {
        context.with_element(self.element_tree(), |context, _element| {
            let result = context.with_clip(self.bounds, |context| {
                draw_content(context, self.viewport())
            });
            if let Some(scrollbar) = self.horizontal_scrollbar() {
                context.draw_component(&scrollbar);
            }
            if let Some(scrollbar) = self.vertical_scrollbar() {
                context.draw_component(&scrollbar);
            }
            result
        })
    }

    fn element_tree(&self) -> ComponentElement {
        Element::leaf("ScrollView").in_bounds(self.bounds)
    }

    fn effective_offset(&self) -> Point {
        let maximum = self.metrics().maximum_offset();
        Point::new(
            if self.axis.permits_horizontal() {
                self.state.horizontal_offset().clamp(0.0, maximum.x)
            } else {
                0.0
            },
            if self.axis.permits_vertical() {
                self.state.vertical_offset().clamp(0.0, maximum.y)
            } else {
                0.0
            },
        )
    }

    fn scrollbar_visible(&self, metrics: ScrollbarMetrics) -> bool {
        match self.style.visibility {
            ScrollbarVisibility::Hidden => false,
            ScrollbarVisibility::Always => true,
            ScrollbarVisibility::Automatic => metrics.maximum_offset() > 0.0,
        }
    }
}

impl Component for ScrollView {
    fn element(&self) -> ComponentElement {
        self.element_tree()
    }

    fn paint(&self, scene: &mut UiScene) {
        if let Some(scrollbar) = self.horizontal_scrollbar() {
            scrollbar.paint(scene);
        }
        if let Some(scrollbar) = self.vertical_scrollbar() {
            scrollbar.paint(scene);
        }
    }
}

#[cfg(test)]
#[path = "scroll_view_tests.rs"]
mod tests;
