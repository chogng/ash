use crate::{Point, Rect, Size};

/// Axes on which a scroll operation or viewport permits movement.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum ScrollAxis {
    Horizontal,
    #[default]
    Vertical,
    Both,
}

impl ScrollAxis {
    pub(super) const fn permits_horizontal(self) -> bool {
        matches!(self, Self::Horizontal | Self::Both)
    }

    pub(super) const fn permits_vertical(self) -> bool {
        matches!(self, Self::Vertical | Self::Both)
    }
}

/// Logical-pixel movement requested from a [`ScrollState`].
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ScrollDelta {
    horizontal: f32,
    vertical: f32,
}

impl ScrollDelta {
    pub const fn horizontal(pixels: f32) -> Self {
        Self {
            horizontal: pixels,
            vertical: 0.0,
        }
    }

    pub const fn vertical(pixels: f32) -> Self {
        Self {
            horizontal: 0.0,
            vertical: pixels,
        }
    }

    pub const fn both(horizontal: f32, vertical: f32) -> Self {
        Self {
            horizontal,
            vertical,
        }
    }
}

/// One explicit transition applied to retained scroll state.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ScrollCommand {
    ByPixels(ScrollDelta),
    ToOffset(Point),
    ToStart(ScrollAxis),
    ToEnd(ScrollAxis),
    EnsureVisible(Rect),
}

/// Viewport and content extents used to clamp scrolling.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollMetrics {
    viewport: Size,
    content: Size,
}

impl ScrollMetrics {
    pub fn new(viewport: Size, content: Size) -> Self {
        assert_size(viewport, "Scroll viewport");
        assert_size(content, "Scroll content");
        Self { viewport, content }
    }

    pub const fn viewport(self) -> Size {
        self.viewport
    }

    pub const fn content(self) -> Size {
        self.content
    }

    pub fn maximum_offset(self) -> Point {
        Point::new(
            (self.content.width - self.viewport.width).max(0.0),
            (self.content.height - self.viewport.height).max(0.0),
        )
    }
}

/// Retained logical-pixel position for a generic scroll viewport.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ScrollState {
    offset: Point,
}

impl ScrollState {
    pub const fn offset(self) -> Point {
        self.offset
    }

    pub const fn horizontal_offset(self) -> f32 {
        self.offset.x
    }

    pub const fn vertical_offset(self) -> f32 {
        self.offset.y
    }

    pub fn apply(
        &mut self,
        command: ScrollCommand,
        metrics: ScrollMetrics,
        permitted_axis: ScrollAxis,
    ) -> bool {
        let previous = self.offset;
        match command {
            ScrollCommand::ByPixels(delta) => {
                assert_delta(delta);
                if permitted_axis.permits_horizontal() {
                    self.offset.x += delta.horizontal;
                }
                if permitted_axis.permits_vertical() {
                    self.offset.y += delta.vertical;
                }
            }
            ScrollCommand::ToOffset(offset) => {
                assert!(
                    offset.x.is_finite() && offset.y.is_finite(),
                    "Scroll offset must be finite"
                );
                if permitted_axis.permits_horizontal() {
                    self.offset.x = offset.x;
                }
                if permitted_axis.permits_vertical() {
                    self.offset.y = offset.y;
                }
            }
            ScrollCommand::ToStart(axis) => {
                if permitted_axis.permits_horizontal() && axis.permits_horizontal() {
                    self.offset.x = 0.0;
                }
                if permitted_axis.permits_vertical() && axis.permits_vertical() {
                    self.offset.y = 0.0;
                }
            }
            ScrollCommand::ToEnd(axis) => {
                let maximum = metrics.maximum_offset();
                if permitted_axis.permits_horizontal() && axis.permits_horizontal() {
                    self.offset.x = maximum.x;
                }
                if permitted_axis.permits_vertical() && axis.permits_vertical() {
                    self.offset.y = maximum.y;
                }
            }
            ScrollCommand::EnsureVisible(bounds) => {
                assert_rect(bounds);
                if permitted_axis.permits_horizontal() {
                    self.offset.x = ensure_axis_visible(
                        self.offset.x,
                        metrics.viewport.width,
                        bounds.origin.x,
                        bounds.size.width,
                    );
                }
                if permitted_axis.permits_vertical() {
                    self.offset.y = ensure_axis_visible(
                        self.offset.y,
                        metrics.viewport.height,
                        bounds.origin.y,
                        bounds.size.height,
                    );
                }
            }
        }
        self.clamp(metrics, permitted_axis);
        self.offset != previous
    }

    pub fn clamp(&mut self, metrics: ScrollMetrics, permitted_axis: ScrollAxis) -> bool {
        let previous = self.offset;
        let maximum = metrics.maximum_offset();
        self.offset.x = if permitted_axis.permits_horizontal() {
            self.offset.x.clamp(0.0, maximum.x)
        } else {
            0.0
        };
        self.offset.y = if permitted_axis.permits_vertical() {
            self.offset.y.clamp(0.0, maximum.y)
        } else {
            0.0
        };
        self.offset != previous
    }
}

fn ensure_axis_visible(offset: f32, viewport: f32, origin: f32, extent: f32) -> f32 {
    if origin < offset {
        origin
    } else if origin + extent > offset + viewport {
        origin + extent - viewport
    } else {
        offset
    }
}

fn assert_delta(delta: ScrollDelta) {
    assert!(
        delta.horizontal.is_finite() && delta.vertical.is_finite(),
        "Scroll delta must be finite"
    );
}

pub(super) fn assert_rect(rect: Rect) {
    assert!(
        rect.origin.x.is_finite()
            && rect.origin.y.is_finite()
            && rect.size.width.is_finite()
            && rect.size.height.is_finite()
            && rect.size.width >= 0.0
            && rect.size.height >= 0.0,
        "Scroll bounds must be finite and non-negative"
    );
}

pub(super) fn assert_size(size: Size, label: &str) {
    assert!(
        size.width.is_finite()
            && size.height.is_finite()
            && size.width >= 0.0
            && size.height >= 0.0,
        "{label} size must be finite and non-negative"
    );
}
