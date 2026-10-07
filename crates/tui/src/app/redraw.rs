use std::time::Duration;
use std::time::Instant;

const FRAME_INTERVAL: Duration = Duration::from_millis(16);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RedrawPriority {
    Batched,
    Immediate,
}

#[derive(Debug, Default)]
pub(super) struct RedrawScheduler {
    deadline: Option<Instant>,
}

impl RedrawScheduler {
    pub(super) fn request(&mut self, now: Instant, priority: RedrawPriority) {
        let requested = match priority {
            RedrawPriority::Batched => now + FRAME_INTERVAL,
            RedrawPriority::Immediate => now,
        };
        self.deadline = Some(
            self.deadline
                .map_or(requested, |deadline| deadline.min(requested)),
        );
    }

    pub(super) fn wait_timeout(&self, now: Instant) -> Option<Duration> {
        self.deadline
            .map(|deadline| deadline.saturating_duration_since(now))
    }

    pub(super) fn take_due(&mut self, now: Instant) -> bool {
        if !self.deadline.is_some_and(|deadline| deadline <= now) {
            return false;
        }
        self.deadline = None;
        true
    }
}

#[cfg(test)]
#[path = "redraw_tests.rs"]
mod tests;
