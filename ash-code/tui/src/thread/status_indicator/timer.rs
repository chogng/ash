use ash_protocol::TurnId;
use std::time::Duration;
use std::time::Instant;

/// Presentation time survives hiding the row and includes time waiting for user input.
#[derive(Debug, Default)]
pub(crate) struct StatusTimer {
    turn_id: Option<TurnId>,
    started_at: Option<Instant>,
    elapsed: Duration,
}

impl StatusTimer {
    pub(crate) fn start(&mut self, now: Instant) {
        self.started_at.get_or_insert(now);
    }

    pub(crate) fn bind_turn(&mut self, turn_id: &TurnId, now: Instant) {
        if self
            .turn_id
            .as_ref()
            .is_some_and(|previous| previous != turn_id)
        {
            self.clear();
        }
        self.turn_id = Some(turn_id.clone());
        self.start(now);
    }

    pub(crate) fn clear(&mut self) {
        *self = Self::default();
    }

    pub(crate) fn tick(&mut self, now: Instant) -> bool {
        let Some(started_at) = self.started_at else {
            return false;
        };
        let elapsed = now.saturating_duration_since(started_at);
        let changed = elapsed.as_millis() / 100 != self.elapsed.as_millis() / 100;
        self.elapsed = elapsed;
        changed
    }

    pub(crate) fn elapsed(&self) -> Duration {
        self.elapsed
    }
}

#[cfg(test)]
#[path = "timer_tests.rs"]
mod tests;
