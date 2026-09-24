use std::time::Instant;

use ash_ui_components::{ScrollbarController, ScrollbarPresentation};
use zui::input::MouseScrollDelta;

const LINES_PER_WHEEL_STEP: f32 = 3.0;
const PIXELS_PER_LINE: f64 = 18.0;

/// Viewport position over terminal-owned retained output.
#[derive(Default)]
pub struct TerminalScroll {
    offset: usize,
    fractional_lines: f64,
    scrollbar: ScrollbarController,
}

impl TerminalScroll {
    pub const fn offset(&self) -> usize {
        self.offset
    }

    pub fn scroll(&mut self, delta: MouseScrollDelta, limit: usize) -> bool {
        let lines = match delta {
            MouseScrollDelta::LineDelta(_, vertical) => f64::from(vertical * LINES_PER_WHEEL_STEP),
            MouseScrollDelta::PixelDelta(position) => position.y / PIXELS_PER_LINE,
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

    pub fn scrollbar_activity(&mut self, now: Instant) {
        self.scrollbar.activity(now);
    }

    pub fn scrollbar_presentation(&self) -> ScrollbarPresentation {
        self.scrollbar.presentation()
    }

    pub fn advance_scrollbar(&mut self, now: Instant) -> bool {
        self.scrollbar.advance(now)
    }

    pub const fn scrollbar_deadline(&self) -> Option<Instant> {
        self.scrollbar.next_deadline()
    }

    pub fn cancel_scrollbar(&mut self) {
        self.scrollbar.cancel();
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
#[path = "scroll_tests.rs"]
mod tests;
