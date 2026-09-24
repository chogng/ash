use std::time::{Duration, Instant};

const DEFAULT_BLINK_INTERVAL: Duration = Duration::from_millis(530);

/// Presentation visibility projected onto a focused text-input caret.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum CaretVisibility {
    /// Paint the caret for the current blink phase.
    Visible,
    /// Preserve caret geometry without painting it.
    Hidden,
}

/// Result of advancing a [`CaretBlinkController`] to the current time.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CaretBlinkAdvance {
    /// The visible presentation did not change.
    Unchanged,
    /// The host must rebuild and redraw with the reported visibility.
    VisibilityChanged(CaretVisibility),
}

/// Platform-independent caret blink state owned and scheduled by a UI host.
///
/// The controller does not create timers or request redraws. Hosts call [`Self::advance`] after
/// their event loop reaches [`Self::next_deadline`], and reset the visible phase after editing
/// activity.
#[derive(Clone, Debug)]
pub struct CaretBlinkController {
    interval: Duration,
    visibility: CaretVisibility,
    next_deadline: Option<Instant>,
}

impl CaretBlinkController {
    /// Creates an inactive controller with the requested half-period.
    ///
    /// # Panics
    ///
    /// Panics when `interval` is zero.
    pub fn new(interval: Duration) -> Self {
        assert!(!interval.is_zero(), "caret blink interval must be non-zero");
        Self {
            interval,
            visibility: CaretVisibility::Hidden,
            next_deadline: None,
        }
    }

    pub const fn visibility(&self) -> CaretVisibility {
        self.visibility
    }

    pub const fn next_deadline(&self) -> Option<Instant> {
        self.next_deadline
    }

    /// Activates blinking with an immediately visible caret.
    pub fn focus(&mut self, now: Instant) {
        self.visibility = CaretVisibility::Visible;
        self.next_deadline = now.checked_add(self.interval);
    }

    /// Stops blinking and hides the caret.
    pub fn blur(&mut self) {
        self.visibility = CaretVisibility::Hidden;
        self.next_deadline = None;
    }

    /// Restarts the visible phase after input or caret movement while focused.
    pub fn activity(&mut self, now: Instant) {
        if self.next_deadline.is_some() {
            self.focus(now);
        }
    }

    /// Advances the blink phase when its deadline has been reached.
    pub fn advance(&mut self, now: Instant) -> CaretBlinkAdvance {
        let Some(deadline) = self.next_deadline else {
            return CaretBlinkAdvance::Unchanged;
        };
        if now < deadline {
            return CaretBlinkAdvance::Unchanged;
        }

        let elapsed_intervals = now.duration_since(deadline).as_nanos() / self.interval.as_nanos();
        let advance = if elapsed_intervals.is_multiple_of(2) {
            self.visibility = match self.visibility {
                CaretVisibility::Visible => CaretVisibility::Hidden,
                CaretVisibility::Hidden => CaretVisibility::Visible,
            };
            CaretBlinkAdvance::VisibilityChanged(self.visibility)
        } else {
            CaretBlinkAdvance::Unchanged
        };
        self.next_deadline = now.checked_add(self.interval);
        advance
    }
}

impl Default for CaretBlinkController {
    fn default() -> Self {
        Self::new(DEFAULT_BLINK_INTERVAL)
    }
}

#[cfg(test)]
#[path = "caret_blink_tests.rs"]
mod tests;
