use ash_protocol::TurnId;
use std::time::Duration;
use std::time::Instant;

/// Presentation time survives hiding the row and includes time waiting for user input.
#[derive(Debug, Default)]
pub(crate) struct StatusTimer {
    turn_id: Option<TurnId>,
    started_at: Option<Instant>,
    elapsed: Duration,
    runs_started: u64,
}

impl StatusTimer {
    pub(crate) fn start(&mut self, now: Instant) {
        if self.started_at.is_none() {
            self.started_at = Some(now);
            self.runs_started += 1;
        }
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
        self.turn_id = None;
        self.started_at = None;
        self.elapsed = Duration::ZERO;
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

    pub(crate) fn runs_started(&self) -> u64 {
        self.runs_started
    }
}

#[cfg(test)]
#[path = "timer_tests.rs"]
mod tests;
