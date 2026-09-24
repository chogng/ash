use std::time::Instant;

/// Earliest wake-up requested by the active frame participants.
///
/// This value type only aggregates monotonic deadlines. The host remains responsible for
/// converting [`Self::next_deadline`] into a platform event-loop control flow.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct FrameDeadlineSet {
    next_deadline: Option<Instant>,
}

impl FrameDeadlineSet {
    /// Includes one deadline and keeps the earliest known wake-up.
    pub fn include(&mut self, deadline: Instant) {
        self.next_deadline = Some(
            self.next_deadline
                .map_or(deadline, |current| current.min(deadline)),
        );
    }

    /// Returns the earliest included wake-up.
    pub const fn next_deadline(self) -> Option<Instant> {
        self.next_deadline
    }

    pub const fn is_empty(self) -> bool {
        self.next_deadline.is_none()
    }
}

#[cfg(test)]
#[path = "deadline_tests.rs"]
mod tests;
