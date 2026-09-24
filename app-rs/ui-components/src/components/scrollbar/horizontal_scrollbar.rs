use super::ScrollbarAxis;
use super::ScrollbarCore;
use super::ScrollbarDrag;
use super::ScrollbarHit;
use super::ScrollbarLayout;
use super::ScrollbarMetrics;
use super::ScrollbarPresentation;
use super::ScrollbarStyle;
use crate::Component;
use crate::ComponentElement;
use crate::Element;
use crate::Point;
use crate::Rect;
use crate::ScrollCommand;
use crate::UiScene;

/// Horizontal scrollbar with compile-time orientation.
///
/// The host provides retained scroll state, scheduling, identity, and accessibility semantics.
/// This component owns horizontal track/thumb geometry, paint, hit testing, track paging, and
/// drag mapping; [`super::ScrollbarController`] owns reusable hover, visibility, and pointer
/// capture.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HorizontalScrollbar {
    core: ScrollbarCore,
}

impl HorizontalScrollbar {
    pub fn new(bounds: Rect, metrics: ScrollbarMetrics, style: ScrollbarStyle) -> Self {
        Self {
            core: ScrollbarCore::new(bounds, metrics, ScrollbarAxis::Horizontal, style),
        }
    }

    pub const fn with_presentation(mut self, presentation: ScrollbarPresentation) -> Self {
        self.core = self.core.with_presentation(presentation);
        self
    }

    pub const fn metrics(self) -> ScrollbarMetrics {
        self.core.metrics()
    }

    pub fn layout(self) -> ScrollbarLayout {
        self.core.layout()
    }

    pub fn track_bounds(self) -> Rect {
        self.core.track_bounds()
    }

    pub fn thumb_bounds(self) -> Rect {
        self.core.thumb_bounds()
    }

    pub fn hit_test(self, point: Point) -> Option<ScrollbarHit> {
        self.core.hit_test(point)
    }

    pub fn begin_drag(
        self,
        hit: ScrollbarHit,
        point: Point,
        starting_offset: Point,
    ) -> Option<ScrollbarDrag> {
        self.core.begin_drag(hit, point, starting_offset)
    }

    pub fn track_click_command(self, hit: ScrollbarHit, point: Point) -> Option<ScrollCommand> {
        self.core.track_click_command(hit, point)
    }
}

impl Component for HorizontalScrollbar {
    fn element(&self) -> ComponentElement {
        Element::leaf("HorizontalScrollbar").in_bounds(self.track_bounds())
    }

    fn paint(&self, scene: &mut UiScene) {
        self.core.paint(scene);
    }
}
