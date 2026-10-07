use ratatui::layout::Rect;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct Insets {
    pub(crate) left: u16,
    pub(crate) top: u16,
    pub(crate) right: u16,
    pub(crate) bottom: u16,
}

impl Insets {
    pub(crate) const fn tlbr(top: u16, left: u16, bottom: u16, right: u16) -> Self {
        Self {
            left,
            top,
            right,
            bottom,
        }
    }

    pub(crate) const fn vh(vertical: u16, horizontal: u16) -> Self {
        Self::tlbr(vertical, horizontal, vertical, horizontal)
    }
}

pub(crate) trait RectExt {
    fn inset(self, insets: Insets) -> Self;
}

impl RectExt for Rect {
    fn inset(self, insets: Insets) -> Self {
        Self {
            x: self.x.saturating_add(insets.left),
            y: self.y.saturating_add(insets.top),
            width: self
                .width
                .saturating_sub(insets.left.saturating_add(insets.right)),
            height: self
                .height
                .saturating_sub(insets.top.saturating_add(insets.bottom)),
        }
    }
}

pub(crate) fn horizontal_margin(area: Rect, margin: u16) -> Rect {
    area.inset(Insets::vh(0, margin))
}

pub(crate) fn bottom_anchored_area(area: Rect, desired_height: u16) -> Rect {
    let height = desired_height.min(area.height);
    Rect {
        y: area.y.saturating_add(area.height).saturating_sub(height),
        height,
        ..area
    }
}

#[cfg(test)]
#[path = "layout_tests.rs"]
mod tests;
