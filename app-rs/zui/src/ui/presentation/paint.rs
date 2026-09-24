use crate::ui::foundation::Color;
use crate::ui::foundation::CornerRadii;
use crate::ui::foundation::Edges;
use crate::ui::foundation::Point;
use crate::ui::foundation::Rect;

/// One rounded rectangular boundary used to clip composed scene content.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClipRect {
    bounds: Rect,
    corner_radii: CornerRadii,
    clip_bounds: Option<Rect>,
}

impl ClipRect {
    pub const fn new(bounds: Rect, corner_radii: CornerRadii) -> Self {
        Self {
            bounds,
            corner_radii,
            clip_bounds: None,
        }
    }

    pub const fn bounds(self) -> Rect {
        self.bounds
    }

    pub fn corner_radii(self) -> CornerRadii {
        self.corner_radii.clamped_for(self.bounds.size)
    }

    pub const fn requested_corner_radii(self) -> CornerRadii {
        self.corner_radii
    }

    pub const fn clip_bounds(self) -> Option<Rect> {
        self.clip_bounds
    }

    pub(crate) fn apply_clip(&mut self, clip_bounds: Rect) {
        self.clip_bounds = Some(match self.clip_bounds {
            Some(current) => current.intersection(clip_bounds),
            None => clip_bounds,
        });
    }
}

/// A colored border with independently configurable edge widths.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Border {
    widths: Edges,
    color: Color,
}

impl Border {
    pub const fn new(widths: Edges, color: Color) -> Self {
        Self { widths, color }
    }

    pub const fn uniform(width: f32, color: Color) -> Self {
        Self::new(Edges::uniform(width), color)
    }

    pub const fn widths(self) -> Edges {
        self.widths
    }

    pub const fn color(self) -> Color {
        self.color
    }
}

impl Default for Border {
    fn default() -> Self {
        Self::uniform(0.0, Color::TRANSPARENT)
    }
}

/// Soft shadow cast by a rounded rectangular paint primitive.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BoxShadow {
    color: Color,
    offset: Point,
    blur_radius: f32,
    spread_radius: f32,
}

impl BoxShadow {
    pub const fn new(color: Color) -> Self {
        Self {
            color,
            offset: Point::new(0.0, 0.0),
            blur_radius: 0.0,
            spread_radius: 0.0,
        }
    }

    pub const fn with_offset(mut self, offset: Point) -> Self {
        self.offset = offset;
        self
    }

    pub const fn with_blur_radius(mut self, blur_radius: f32) -> Self {
        self.blur_radius = blur_radius;
        self
    }

    /// Expands or contracts the shadow silhouette before blur is applied.
    pub const fn with_spread_radius(mut self, spread_radius: f32) -> Self {
        self.spread_radius = spread_radius;
        self
    }

    pub const fn color(self) -> Color {
        self.color
    }

    pub const fn offset(self) -> Point {
        self.offset
    }

    pub const fn blur_radius(self) -> f32 {
        self.blur_radius
    }

    pub const fn spread_radius(self) -> f32 {
        self.spread_radius
    }
}

/// A filled rectangular paint primitive with an optional shadow, border, and rounded corners.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PaintRect {
    bounds: Rect,
    fill: Color,
    shadow: Option<BoxShadow>,
    border: Border,
    corner_radii: CornerRadii,
    clip_bounds: Option<Rect>,
}

impl PaintRect {
    pub const fn new(bounds: Rect, fill: Color) -> Self {
        Self {
            bounds,
            fill,
            shadow: None,
            border: Border::uniform(0.0, Color::TRANSPARENT),
            corner_radii: CornerRadii::uniform(0.0),
            clip_bounds: None,
        }
    }

    pub const fn with_shadow(mut self, shadow: BoxShadow) -> Self {
        self.shadow = Some(shadow);
        self
    }

    pub const fn with_border(mut self, border: Border) -> Self {
        self.border = border;
        self
    }

    pub const fn with_corner_radii(mut self, corner_radii: CornerRadii) -> Self {
        self.corner_radii = corner_radii;
        self
    }

    pub const fn bounds(self) -> Rect {
        self.bounds
    }

    pub const fn fill(self) -> Color {
        self.fill
    }

    pub const fn shadow(self) -> Option<BoxShadow> {
        self.shadow
    }

    pub const fn border(self) -> Border {
        self.border
    }

    pub fn corner_radii(self) -> CornerRadii {
        self.corner_radii.clamped_for(self.bounds.size)
    }

    /// Returns the caller-requested radii before renderer-side bounds clamping.
    pub const fn requested_corner_radii(self) -> CornerRadii {
        self.corner_radii
    }

    /// Returns the resolved scene clip consumed by renderer backends.
    pub const fn clip_bounds(self) -> Option<Rect> {
        self.clip_bounds
    }

    pub(crate) fn apply_clip(&mut self, clip_bounds: Rect) {
        self.clip_bounds = Some(match self.clip_bounds {
            Some(current) => current.intersection(clip_bounds),
            None => clip_bounds,
        });
    }
}

#[cfg(test)]
#[path = "paint_tests.rs"]
mod tests;
