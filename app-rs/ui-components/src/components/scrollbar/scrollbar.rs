use crate::Color;
use crate::CornerRadii;
use crate::PaintRect;
use crate::Point;
use crate::Rect;
use crate::ScrollCommand;
use crate::ScrollDelta;
use crate::UiScene;

#[path = "horizontal_scrollbar.rs"]
mod horizontal_scrollbar;
#[path = "interaction.rs"]
mod interaction;
#[path = "vertical_scrollbar.rs"]
mod vertical_scrollbar;

pub use horizontal_scrollbar::HorizontalScrollbar;
pub use interaction::ScrollbarController;
pub use interaction::ScrollbarInteractionOutcome;
pub use interaction::ScrollbarPresentation;
pub use interaction::ScrollbarState;
pub use vertical_scrollbar::VerticalScrollbar;

/// One valid scrollbar axis.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ScrollbarAxis {
    Horizontal,
    Vertical,
}

/// Viewport, content, and offset values for one scrollbar axis.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollbarMetrics {
    viewport_extent: f32,
    content_extent: f32,
    offset: f32,
}

impl ScrollbarMetrics {
    pub fn new(viewport_extent: f32, content_extent: f32, offset: f32) -> Self {
        assert_non_negative_finite(viewport_extent, "Scrollbar viewport extent");
        assert_non_negative_finite(content_extent, "Scrollbar content extent");
        assert!(offset.is_finite(), "Scrollbar offset must be finite");
        Self {
            viewport_extent,
            content_extent,
            offset,
        }
    }

    pub const fn viewport_extent(self) -> f32 {
        self.viewport_extent
    }

    pub const fn content_extent(self) -> f32 {
        self.content_extent
    }

    pub fn maximum_offset(self) -> f32 {
        (self.content_extent - self.viewport_extent).max(0.0)
    }

    pub fn offset(self) -> f32 {
        self.offset.clamp(0.0, self.maximum_offset())
    }
}

/// Component-owned visual and geometry tokens for scrollbars.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollbarStyle {
    track: Color,
    hovered_track: Color,
    active_track: Color,
    thumb: Color,
    hovered_thumb: Color,
    active_thumb: Color,
    thickness: f32,
    minimum_thumb_extent: f32,
    corner_radii: CornerRadii,
}

impl ScrollbarStyle {
    pub const fn new(track: Color, thumb: Color) -> Self {
        Self {
            track,
            hovered_track: track,
            active_track: track,
            thumb,
            hovered_thumb: thumb,
            active_thumb: thumb,
            thickness: 8.0,
            minimum_thumb_extent: 24.0,
            corner_radii: CornerRadii::uniform(4.0),
        }
    }

    pub const fn with_hovered_colors(mut self, track: Color, thumb: Color) -> Self {
        self.hovered_track = track;
        self.hovered_thumb = thumb;
        self
    }

    pub const fn with_active_colors(mut self, track: Color, thumb: Color) -> Self {
        self.active_track = track;
        self.active_thumb = thumb;
        self
    }

    pub const fn with_thickness(mut self, thickness: f32) -> Self {
        self.thickness = thickness;
        self
    }

    pub const fn with_minimum_thumb_extent(mut self, extent: f32) -> Self {
        self.minimum_thumb_extent = extent;
        self
    }

    pub const fn with_corner_radii(mut self, corner_radii: CornerRadii) -> Self {
        self.corner_radii = corner_radii;
        self
    }
}

/// Resolved track and thumb geometry for one scrollbar.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollbarLayout {
    axis: ScrollbarAxis,
    track_bounds: Rect,
    thumb_bounds: Rect,
}

impl ScrollbarLayout {
    pub const fn axis(self) -> ScrollbarAxis {
        self.axis
    }

    pub const fn track_bounds(self) -> Rect {
        self.track_bounds
    }

    pub const fn thumb_bounds(self) -> Rect {
        self.thumb_bounds
    }
}

/// Semantic region under a pointer within one scrollbar.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ScrollbarPart {
    Track,
    Thumb,
}

/// Axis and semantic part returned by scrollbar hit testing.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ScrollbarHit {
    axis: ScrollbarAxis,
    part: ScrollbarPart,
}

impl ScrollbarHit {
    pub const fn axis(self) -> ScrollbarAxis {
        self.axis
    }

    pub const fn part(self) -> ScrollbarPart {
        self.part
    }
}

/// Stable mapping captured when a scrollbar thumb drag begins.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollbarDrag {
    axis: ScrollbarAxis,
    track_origin: f32,
    available_travel: f32,
    grab_offset: f32,
    maximum_offset: f32,
    starting_offset: Point,
}

impl ScrollbarDrag {
    pub const fn axis(self) -> ScrollbarAxis {
        self.axis
    }

    /// Maps a pointer position back into an absolute logical content offset.
    pub fn command_at(self, point: Point) -> ScrollCommand {
        assert_point(point);
        let pointer = axis_coordinate(self.axis, point);
        let thumb_offset =
            (pointer - self.track_origin - self.grab_offset).clamp(0.0, self.available_travel);
        let content_offset = if self.available_travel > 0.0 {
            thumb_offset / self.available_travel * self.maximum_offset
        } else {
            0.0
        };
        let offset = match self.axis {
            ScrollbarAxis::Horizontal => Point::new(content_offset, self.starting_offset.y),
            ScrollbarAxis::Vertical => Point::new(self.starting_offset.x, content_offset),
        };
        ScrollCommand::ToOffset(offset)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct ScrollbarCore {
    bounds: Rect,
    metrics: ScrollbarMetrics,
    axis: ScrollbarAxis,
    style: ScrollbarStyle,
    presentation: ScrollbarPresentation,
}

impl ScrollbarCore {
    fn new(
        bounds: Rect,
        metrics: ScrollbarMetrics,
        axis: ScrollbarAxis,
        style: ScrollbarStyle,
    ) -> Self {
        assert_rect(bounds);
        Self {
            bounds,
            metrics,
            axis,
            style,
            presentation: ScrollbarPresentation::default(),
        }
    }

    const fn with_presentation(mut self, presentation: ScrollbarPresentation) -> Self {
        self.presentation = presentation;
        self
    }

    const fn metrics(self) -> ScrollbarMetrics {
        self.metrics
    }

    fn layout(self) -> ScrollbarLayout {
        let thickness = self.style.thickness.max(0.0);
        let track_bounds = match self.axis {
            ScrollbarAxis::Vertical => Rect::from_xywh(
                self.bounds.right() - thickness,
                self.bounds.origin.y,
                thickness,
                self.bounds.size.height,
            ),
            ScrollbarAxis::Horizontal => Rect::from_xywh(
                self.bounds.origin.x,
                self.bounds.bottom() - thickness,
                self.bounds.size.width,
                thickness,
            ),
        };
        let track_extent = axis_extent(self.axis, track_bounds);
        let thumb_extent = if self.metrics.content_extent() <= 0.0 {
            track_extent
        } else {
            (track_extent * self.metrics.viewport_extent() / self.metrics.content_extent())
                .max(self.style.minimum_thumb_extent.max(0.0))
                .min(track_extent)
        };
        let available_travel = (track_extent - thumb_extent).max(0.0);
        let thumb_offset = if self.metrics.maximum_offset() > 0.0 {
            self.metrics.offset() / self.metrics.maximum_offset() * available_travel
        } else {
            0.0
        };
        let thumb_bounds = match self.axis {
            ScrollbarAxis::Vertical => Rect::from_xywh(
                track_bounds.origin.x,
                track_bounds.origin.y + thumb_offset,
                track_bounds.size.width,
                thumb_extent,
            ),
            ScrollbarAxis::Horizontal => Rect::from_xywh(
                track_bounds.origin.x + thumb_offset,
                track_bounds.origin.y,
                thumb_extent,
                track_bounds.size.height,
            ),
        };
        ScrollbarLayout {
            axis: self.axis,
            track_bounds,
            thumb_bounds,
        }
    }

    fn track_bounds(self) -> Rect {
        self.layout().track_bounds()
    }

    fn thumb_bounds(self) -> Rect {
        self.layout().thumb_bounds()
    }

    fn hit_test(self, point: Point) -> Option<ScrollbarHit> {
        assert_point(point);
        let layout = self.layout();
        if layout.thumb_bounds.contains(point) {
            Some(ScrollbarHit {
                axis: self.axis,
                part: ScrollbarPart::Thumb,
            })
        } else if layout.track_bounds.contains(point) {
            Some(ScrollbarHit {
                axis: self.axis,
                part: ScrollbarPart::Track,
            })
        } else {
            None
        }
    }

    fn begin_drag(
        self,
        hit: ScrollbarHit,
        point: Point,
        starting_offset: Point,
    ) -> Option<ScrollbarDrag> {
        assert_point(point);
        assert_point(starting_offset);
        if hit.axis != self.axis || hit.part != ScrollbarPart::Thumb {
            return None;
        }
        let layout = self.layout();
        let track_origin = axis_origin(self.axis, layout.track_bounds);
        let thumb_origin = axis_origin(self.axis, layout.thumb_bounds);
        let track_extent = axis_extent(self.axis, layout.track_bounds);
        let thumb_extent = axis_extent(self.axis, layout.thumb_bounds);
        Some(ScrollbarDrag {
            axis: self.axis,
            track_origin,
            available_travel: (track_extent - thumb_extent).max(0.0),
            grab_offset: axis_coordinate(self.axis, point) - thumb_origin,
            maximum_offset: self.metrics.maximum_offset(),
            starting_offset,
        })
    }

    fn track_click_command(self, hit: ScrollbarHit, point: Point) -> Option<ScrollCommand> {
        assert_point(point);
        if hit.axis != self.axis || hit.part != ScrollbarPart::Track {
            return None;
        }
        let layout = self.layout();
        let pointer = axis_coordinate(self.axis, point);
        let thumb_start = axis_origin(self.axis, layout.thumb_bounds);
        let thumb_end = thumb_start + axis_extent(self.axis, layout.thumb_bounds);
        let direction = if pointer < thumb_start {
            -1.0
        } else if pointer >= thumb_end {
            1.0
        } else {
            return None;
        };
        Some(ScrollCommand::ByPixels(match self.axis {
            ScrollbarAxis::Horizontal => {
                ScrollDelta::horizontal(direction * self.metrics.viewport_extent())
            }
            ScrollbarAxis::Vertical => {
                ScrollDelta::vertical(direction * self.metrics.viewport_extent())
            }
        }))
    }

    fn colors(self) -> (Color, Color) {
        match self.presentation.state() {
            ScrollbarState::Resting => (self.style.track, self.style.thumb),
            ScrollbarState::Hovered => (self.style.hovered_track, self.style.hovered_thumb),
            ScrollbarState::Active => (self.style.active_track, self.style.active_thumb),
        }
    }

    fn paint(self, scene: &mut UiScene) {
        let opacity = self.presentation.opacity();
        if opacity <= 0.0 {
            return;
        }
        let layout = self.layout();
        let (track, thumb) = self.colors();
        scene.draw_rect(
            PaintRect::new(layout.track_bounds, color_with_opacity(track, opacity))
                .with_corner_radii(self.style.corner_radii),
        );
        scene.draw_rect(
            PaintRect::new(layout.thumb_bounds, color_with_opacity(thumb, opacity))
                .with_corner_radii(self.style.corner_radii),
        );
    }
}

fn axis_coordinate(axis: ScrollbarAxis, point: Point) -> f32 {
    match axis {
        ScrollbarAxis::Horizontal => point.x,
        ScrollbarAxis::Vertical => point.y,
    }
}

fn axis_origin(axis: ScrollbarAxis, bounds: Rect) -> f32 {
    axis_coordinate(axis, bounds.origin)
}

fn axis_extent(axis: ScrollbarAxis, bounds: Rect) -> f32 {
    match axis {
        ScrollbarAxis::Horizontal => bounds.size.width,
        ScrollbarAxis::Vertical => bounds.size.height,
    }
}

fn color_with_opacity(color: Color, opacity: f32) -> Color {
    let [red, green, blue, alpha] = color.components();
    Color::rgba(
        red,
        green,
        blue,
        (f32::from(alpha) * opacity.clamp(0.0, 1.0)).round() as u8,
    )
}

fn assert_rect(rect: Rect) {
    assert!(
        rect.origin.x.is_finite()
            && rect.origin.y.is_finite()
            && rect.size.width.is_finite()
            && rect.size.height.is_finite()
            && rect.size.width >= 0.0
            && rect.size.height >= 0.0,
        "Scrollbar bounds must be finite and non-negative"
    );
}

fn assert_point(point: Point) {
    assert!(
        point.x.is_finite() && point.y.is_finite(),
        "Scrollbar point must be finite"
    );
}

fn assert_non_negative_finite(value: f32, label: &str) {
    assert!(
        value.is_finite() && value >= 0.0,
        "{label} must be finite and non-negative"
    );
}

#[cfg(test)]
#[path = "scrollbar_tests.rs"]
mod tests;
