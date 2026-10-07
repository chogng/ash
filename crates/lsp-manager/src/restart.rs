//! Bounded restart policy and consecutive-failure accounting.

use std::num::NonZeroU32;
use std::time::{Duration, Instant};

/// Product policy controlling recovery after a language-server launch or transport failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LanguageServerRestartPolicy {
    /// Surface the first failure without scheduling another process.
    Never,
    /// Retry with a bounded exponential delay until the restart budget is exhausted.
    BoundedExponential {
        maximum_restarts: NonZeroU32,
        initial_delay: Duration,
        maximum_delay: Duration,
        healthy_window: Duration,
    },
}

impl LanguageServerRestartPolicy {
    /// Production default: five restarts from 250 ms through a four-second cap.
    pub const fn standard() -> Self {
        Self::BoundedExponential {
            maximum_restarts: NonZeroU32::new(5).expect("five is non-zero"),
            initial_delay: Duration::from_millis(250),
            maximum_delay: Duration::from_secs(4),
            healthy_window: Duration::from_secs(60),
        }
    }

    /// Creates a caller-tuned bounded policy, primarily for product profiles and deterministic
    /// integration tests. A maximum delay below the initial delay is raised to the initial delay.
    pub fn bounded_exponential(
        maximum_restarts: NonZeroU32,
        initial_delay: Duration,
        maximum_delay: Duration,
        healthy_window: Duration,
    ) -> Self {
        Self::BoundedExponential {
            maximum_restarts,
            initial_delay,
            maximum_delay: maximum_delay.max(initial_delay),
            healthy_window,
        }
    }
}

impl Default for LanguageServerRestartPolicy {
    fn default() -> Self {
        Self::standard()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RestartDecision {
    Failed(String),
    Backoff {
        attempt: u32,
        retry_after: Duration,
    },
    CrashLoop {
        restart_attempts: u32,
        message: String,
    },
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ServerRestartTracker {
    restart_attempts: u32,
    ready_since: Option<Instant>,
}

impl ServerRestartTracker {
    pub(crate) fn mark_ready(&mut self, now: Instant) {
        self.ready_since = Some(now);
    }

    pub(crate) fn reset(&mut self) {
        self.restart_attempts = 0;
        self.ready_since = None;
    }

    pub(crate) fn failure(
        &mut self,
        now: Instant,
        message: String,
        policy: LanguageServerRestartPolicy,
    ) -> RestartDecision {
        let LanguageServerRestartPolicy::BoundedExponential {
            maximum_restarts,
            initial_delay,
            maximum_delay,
            healthy_window,
        } = policy
        else {
            self.ready_since = None;
            return RestartDecision::Failed(message);
        };
        if self
            .ready_since
            .is_some_and(|ready| now.saturating_duration_since(ready) >= healthy_window)
        {
            self.restart_attempts = 0;
        }
        self.ready_since = None;
        if self.restart_attempts >= maximum_restarts.get() {
            return RestartDecision::CrashLoop {
                restart_attempts: self.restart_attempts,
                message,
            };
        }
        self.restart_attempts += 1;
        let exponent = self.restart_attempts.saturating_sub(1).min(31);
        let multiplier = 1_u32.checked_shl(exponent).unwrap_or(u32::MAX);
        RestartDecision::Backoff {
            attempt: self.restart_attempts,
            retry_after: initial_delay.saturating_mul(multiplier).min(maximum_delay),
        }
    }
}

#[cfg(test)]
#[path = "restart_tests.rs"]
mod tests;
