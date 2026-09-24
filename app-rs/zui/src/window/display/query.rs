use super::Display;
use super::DisplayId;
use super::DisplaySnapshot;
use crate::window::PhysicalBounds;
use crate::window::PhysicalPosition;

impl DisplaySnapshot {
    /// Returns the connected display with `id`.
    pub fn display(&self, id: &DisplayId) -> Option<&Display> {
        self.displays.iter().find(|display| display.id() == id)
    }

    /// Returns the display containing `point`, or the closest display when it lies outside all.
    ///
    /// Coordinates use the global physical screen space. Ties preserve backend topology order.
    pub fn display_nearest_point(&self, point: PhysicalPosition) -> Option<&Display> {
        if !point.x.is_finite() || !point.y.is_finite() {
            return None;
        }
        let mut nearest = None;
        let mut nearest_distance = f64::INFINITY;
        for display in &self.displays {
            let Some(rect) = Rect::from_bounds(display.bounds()) else {
                continue;
            };
            if rect.contains(point) {
                return Some(display);
            }
            let distance = rect.distance_squared(point);
            if distance < nearest_distance {
                nearest = Some(display);
                nearest_distance = distance;
            }
        }
        nearest
    }

    /// Returns the display with the largest overlap with `bounds`.
    ///
    /// If no display overlaps the rectangle, the display nearest its center is returned. Ties
    /// preserve backend topology order. Non-finite rectangle coordinates return `None`.
    pub fn display_matching(&self, bounds: PhysicalBounds) -> Option<&Display> {
        let query = Rect::from_bounds(bounds)?;
        let mut matching = None;
        let mut matching_area = 0.0;
        for display in &self.displays {
            let Some(display_rect) = Rect::from_bounds(display.bounds()) else {
                continue;
            };
            let area = query.intersection_area(display_rect);
            if area > matching_area {
                matching = Some(display);
                matching_area = area;
            }
        }
        if matching.is_some() {
            matching
        } else {
            self.display_nearest_point(query.center())
        }
    }
}

#[derive(Clone, Copy)]
struct Rect {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

impl Rect {
    fn from_bounds(bounds: PhysicalBounds) -> Option<Self> {
        let position = bounds.position();
        let extent = bounds.extent();
        let right = position.x + f64::from(extent.width);
        let bottom = position.y + f64::from(extent.height);
        if !position.x.is_finite()
            || !position.y.is_finite()
            || !right.is_finite()
            || !bottom.is_finite()
        {
            return None;
        }
        Some(Self {
            left: position.x,
            top: position.y,
            right,
            bottom,
        })
    }

    fn center(self) -> PhysicalPosition {
        PhysicalPosition::new(
            self.left + (self.right - self.left) / 2.0,
            self.top + (self.bottom - self.top) / 2.0,
        )
    }

    fn contains(self, point: PhysicalPosition) -> bool {
        point.x >= self.left && point.x < self.right && point.y >= self.top && point.y < self.bottom
    }

    fn distance_squared(self, point: PhysicalPosition) -> f64 {
        let horizontal = if point.x < self.left {
            self.left - point.x
        } else if point.x > self.right {
            point.x - self.right
        } else {
            0.0
        };
        let vertical = if point.y < self.top {
            self.top - point.y
        } else if point.y > self.bottom {
            point.y - self.bottom
        } else {
            0.0
        };
        horizontal * horizontal + vertical * vertical
    }

    fn intersection_area(self, other: Self) -> f64 {
        let width = self.right.min(other.right) - self.left.max(other.left);
        let height = self.bottom.min(other.bottom) - self.top.max(other.top);
        width.max(0.0) * height.max(0.0)
    }
}
