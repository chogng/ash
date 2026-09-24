use crate::ui::foundation::Color;
use crate::ui::foundation::Icon;
use crate::ui::foundation::Rect;

/// A caller-colored semantic icon placed in logical UI coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PaintIcon {
    icon: Icon,
    bounds: Rect,
    color: Color,
    clip_bounds: Option<Rect>,
}

impl PaintIcon {
    pub const fn new(icon: Icon, bounds: Rect, color: Color) -> Self {
        Self {
            icon,
            bounds,
            color,
            clip_bounds: None,
        }
    }

    pub const fn icon(self) -> Icon {
        self.icon
    }

    pub const fn bounds(self) -> Rect {
        self.bounds
    }

    pub const fn color(self) -> Color {
        self.color
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
