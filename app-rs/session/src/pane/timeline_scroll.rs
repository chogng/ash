//! Retained scroll state for the Thread timeline.

const LINES_PER_WHEEL_STEP: f32 = 3.0;
const PIXELS_PER_LINE: f64 = 20.0;

/// Host-neutral wheel input for the Thread timeline.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TimelineScrollDelta {
    Lines(f32),
    Pixels(f64),
}

/// Ephemeral scroll position over the current Agent Thread timeline.
#[derive(Default)]
pub struct ThreadTimelineScroll {
    offset: usize,
    fractional_lines: f64,
}

impl ThreadTimelineScroll {
    pub const fn offset(&self) -> usize {
        self.offset
    }

    pub fn scroll(&mut self, delta: TimelineScrollDelta, limit: usize) -> bool {
        let lines = match delta {
            TimelineScrollDelta::Lines(vertical) => f64::from(vertical * LINES_PER_WHEEL_STEP),
            TimelineScrollDelta::Pixels(vertical) => vertical / PIXELS_PER_LINE,
        };
        if lines.signum() != self.fractional_lines.signum() {
            self.fractional_lines = 0.0;
        }
        self.fractional_lines += lines;
        let whole_lines = self.fractional_lines.trunc() as isize;
        self.fractional_lines -= whole_lines as f64;
        let previous = self.offset;
        if whole_lines > 0 {
            self.offset = self.offset.saturating_add(whole_lines as usize).min(limit);
        } else {
            self.offset = self.offset.saturating_sub(whole_lines.unsigned_abs());
        }
        self.offset != previous
    }

    pub fn preserve_view_after_growth(&mut self, added_lines: usize, limit: usize) {
        if self.offset > 0 {
            self.offset = self.offset.saturating_add(added_lines).min(limit);
        }
    }

    pub fn clamp(&mut self, limit: usize) {
        self.offset = self.offset.min(limit);
    }

    pub fn reset(&mut self) {
        self.offset = 0;
        self.fractional_lines = 0.0;
    }
}

#[cfg(test)]
#[path = "timeline_scroll_tests.rs"]
mod tests;
