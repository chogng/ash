use std::time::{Duration, Instant};

use zui::ui::{Point, Rect};

const SELECTION_AUTO_SCROLL_INTERVAL: Duration = Duration::from_millis(35);
const SELECTION_AUTO_SCROLL_EDGE: f32 = 8.0;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum FileEditorAutoScrollDirection {
    #[default]
    Idle,
    Up,
    Down,
}

impl FileEditorAutoScrollDirection {
    pub const fn row_delta(self) -> isize {
        match self {
            Self::Idle => 0,
            Self::Up => -1,
            Self::Down => 1,
        }
    }
}

/// Retained timer state for pointer selection beyond the visible editor viewport.
#[derive(Clone, Copy, Debug, Default)]
pub struct FileEditorAutoScrollState {
    direction: FileEditorAutoScrollDirection,
    deadline: Option<Instant>,
}

impl FileEditorAutoScrollState {
    pub fn update(&mut self, point: Point, bounds: Rect, now: Instant) {
        let direction = if point.y < bounds.origin.y + SELECTION_AUTO_SCROLL_EDGE {
            FileEditorAutoScrollDirection::Up
        } else if point.y >= bounds.bottom() - SELECTION_AUTO_SCROLL_EDGE {
            FileEditorAutoScrollDirection::Down
        } else {
            FileEditorAutoScrollDirection::Idle
        };
        if direction == FileEditorAutoScrollDirection::Idle {
            self.stop();
        } else if direction != self.direction {
            self.direction = direction;
            self.deadline = Some(now);
        }
    }

    pub fn advance(&mut self, now: Instant) -> FileEditorAutoScrollDirection {
        let Some(deadline) = self.deadline else {
            return FileEditorAutoScrollDirection::Idle;
        };
        if now < deadline {
            return FileEditorAutoScrollDirection::Idle;
        }
        let direction = self.direction;
        self.deadline = Some(now + SELECTION_AUTO_SCROLL_INTERVAL);
        direction
    }

    pub fn stop(&mut self) {
        self.direction = FileEditorAutoScrollDirection::Idle;
        self.deadline = None;
    }

    pub const fn deadline(self) -> Option<Instant> {
        self.deadline
    }
}

#[cfg(test)]
#[path = "auto_scroll_tests.rs"]
mod tests;
