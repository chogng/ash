use std::time::Duration;
use std::time::Instant;

/// Pointer relationship projected into a reusable [`Hover`] state.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum HoverPresence {
    #[default]
    Outside,
    Over,
}

/// Backend-independent hover state with optional delayed entry.
///
/// Callers aggregate the pointer relationship for the regions that form one hover base, then
/// project that relationship with [`Self::pointer_presence`]. Components decide whether hover
/// changes color, reveals content, opens a popover, or only changes cursor feedback.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hover {
    delay: Duration,
    hovered: bool,
    deadline: Option<Instant>,
}

impl Hover {
    /// Creates hover state with an explicit entry delay. A zero delay enters immediately.
    pub const fn new(delay: Duration) -> Self {
        Self {
            delay,
            hovered: false,
            deadline: None,
        }
    }

    pub const fn is_hovered(self) -> bool {
        self.hovered
    }

    pub const fn next_deadline(self) -> Option<Instant> {
        self.deadline
    }

    /// Projects the aggregated pointer relationship for this hover base.
    pub fn pointer_presence(&mut self, presence: HoverPresence, now: Instant) -> bool {
        match presence {
            HoverPresence::Outside => self.cancel(),
            HoverPresence::Over if self.hovered || self.deadline.is_some() => false,
            HoverPresence::Over if self.delay.is_zero() => self.hover_now(),
            HoverPresence::Over => {
                self.deadline = Some(
                    now.checked_add(self.delay)
                        .expect("hover deadline must remain within the Instant range"),
                );
                false
            }
        }
    }

    /// Enters hover immediately, including after an active pointer gesture ends over the base.
    pub fn hover_now(&mut self) -> bool {
        let changed = !self.hovered;
        self.hovered = true;
        self.deadline = None;
        changed
    }

    /// Clears visible and pending hover state.
    pub fn cancel(&mut self) -> bool {
        let changed = self.hovered;
        self.hovered = false;
        self.deadline = None;
        changed
    }

    /// Resolves delayed entry and reports whether visible hover changed.
    pub fn advance(&mut self, now: Instant) -> bool {
        let Some(deadline) = self.deadline else {
            return false;
        };
        if now < deadline {
            return false;
        }
        self.hover_now()
    }
}

impl Default for Hover {
    fn default() -> Self {
        Self::new(Duration::ZERO)
    }
}

#[cfg(test)]
#[path = "hover_tests.rs"]
mod tests;
