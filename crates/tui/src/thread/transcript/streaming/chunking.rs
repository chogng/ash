//! Pure queue-pressure decisions. The caller owns deadlines and drains.
use std::time::Duration;
use std::time::Instant;

const ENTER_LINES: usize = 8;
const ENTER_AGE: Duration = Duration::from_millis(120);
const EXIT_LINES: usize = 2;
const EXIT_AGE: Duration = Duration::from_millis(40);
const HOLD: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum Mode {
    #[default]
    Smooth,
    CatchUp,
}

#[derive(Debug, Default)]
pub(super) struct ChunkingPolicy {
    mode: Mode,
    low_since: Option<Instant>,
    exited_at: Option<Instant>,
}

impl ChunkingPolicy {
    /// Returns how many queued source lines may become visible at this deadline.
    pub(super) fn drain_count(
        &mut self,
        lines: usize,
        oldest_age: Duration,
        now: Instant,
    ) -> usize {
        if lines == 0 {
            if self.mode == Mode::CatchUp {
                self.exited_at = Some(now);
            }
            self.mode = Mode::Smooth;
            self.low_since = None;
            return 0;
        }
        match self.mode {
            Mode::Smooth => {
                let severe = lines >= 64 || oldest_age >= Duration::from_millis(300);
                let cooling = self
                    .exited_at
                    .is_some_and(|at| now.saturating_duration_since(at) < HOLD);
                if (lines >= ENTER_LINES || oldest_age >= ENTER_AGE) && (!cooling || severe) {
                    self.mode = Mode::CatchUp;
                    self.low_since = None;
                    self.exited_at = None;
                }
            }
            Mode::CatchUp => {
                if lines <= EXIT_LINES && oldest_age <= EXIT_AGE {
                    let since = *self.low_since.get_or_insert(now);
                    if now.saturating_duration_since(since) >= HOLD {
                        self.mode = Mode::Smooth;
                        self.exited_at = Some(now);
                        self.low_since = None;
                    }
                } else {
                    self.low_since = None;
                }
            }
        }
        match self.mode {
            Mode::Smooth => 1,
            Mode::CatchUp => lines,
        }
    }
}

#[cfg(test)]
#[path = "chunking_tests.rs"]
mod tests;
