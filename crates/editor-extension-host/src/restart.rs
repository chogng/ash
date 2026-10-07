use std::collections::VecDeque;
use std::time::Duration;

use crate::ExtensionHostError;

/// Bounded restart window and exponential delay for one extension process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RestartPolicy {
    pub maximum_restarts: usize,
    pub window: Duration,
    pub initial_delay: Duration,
    pub maximum_delay: Duration,
}

impl RestartPolicy {
    pub fn validate(self) -> Result<(), ExtensionHostError> {
        if self.maximum_restarts == 0
            || self.window.is_zero()
            || self.initial_delay.is_zero()
            || self.maximum_delay < self.initial_delay
        {
            return Err(ExtensionHostError::InvalidLimits(
                "restart policy must have a non-zero bounded window and delay",
            ));
        }
        Ok(())
    }
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self {
            maximum_restarts: 5,
            window: Duration::from_secs(60),
            initial_delay: Duration::from_millis(100),
            maximum_delay: Duration::from_secs(5),
        }
    }
}

/// Decision made after recording one unexpected process failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RestartDecision {
    RestartAfter(Duration),
    CrashLoop,
}

/// Deterministic crash-window tracker. Callers supply monotonic elapsed time for testability.
pub struct RestartTracker {
    policy: RestartPolicy,
    failures: VecDeque<Duration>,
    consecutive_failures: u32,
}

impl RestartTracker {
    pub fn new(policy: RestartPolicy) -> Result<Self, ExtensionHostError> {
        policy.validate()?;
        Ok(Self {
            policy,
            failures: VecDeque::new(),
            consecutive_failures: 0,
        })
    }

    pub fn record_failure(&mut self, now: Duration) -> RestartDecision {
        while self
            .failures
            .front()
            .is_some_and(|failure| now.saturating_sub(*failure) >= self.policy.window)
        {
            self.failures.pop_front();
        }
        if self.failures.len() >= self.policy.maximum_restarts {
            return RestartDecision::CrashLoop;
        }
        self.failures.push_back(now);
        let exponent = self.consecutive_failures.min(31);
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        let multiplier = 1_u32 << exponent;
        RestartDecision::RestartAfter(
            self.policy
                .initial_delay
                .saturating_mul(multiplier)
                .min(self.policy.maximum_delay),
        )
    }

    /// Resets exponential backoff after the caller's health threshold has been met.
    pub fn record_healthy(&mut self) {
        self.consecutive_failures = 0;
    }
}

#[cfg(test)]
#[path = "restart_tests.rs"]
mod tests;
