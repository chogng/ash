use std::num::NonZeroU8;
use std::time::Duration;

/// Evidence that authorizations an HTTP request to be replayed.
///
/// The client owns the attempt loop, but the runtime/API layer must choose
/// this value from the operation's documented semantics. Model inference POSTs
/// normally use [`RetrySafety::Never`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RetrySafety {
    Never,
    Idempotent,
    ExplicitIdempotencyKey,
}

/// Bounded exponential backoff parameters without jitter.
///
/// A transport implementation may inject jitter when scheduling an attempt;
/// keeping this calculation deterministic makes policy validation testable.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BackoffPolicy {
    initial_delay: Duration,
    max_delay: Duration,
}

impl BackoffPolicy {
    pub fn new(initial_delay: Duration, max_delay: Duration) -> Self {
        Self {
            initial_delay: initial_delay.min(max_delay),
            max_delay,
        }
    }

    /// Returns the bounded delay before a zero-based retry attempt.
    pub fn delay_before_retry(self, retry_index: u8) -> Duration {
        let multiplier = 1u32.checked_shl(u32::from(retry_index)).unwrap_or(u32::MAX);
        self.initial_delay
            .saturating_mul(multiplier)
            .min(self.max_delay)
    }
}

/// A typed retry policy selected by the operation owner and executed by the
/// client transport.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RetryPolicy {
    safety: RetrySafety,
    max_attempts: NonZeroU8,
    backoff: BackoffPolicy,
}

impl RetryPolicy {
    /// Disables replay and authorizations exactly one request attempt.
    pub fn never() -> Self {
        Self {
            safety: RetrySafety::Never,
            max_attempts: NonZeroU8::MIN,
            backoff: BackoffPolicy::new(Duration::ZERO, Duration::ZERO),
        }
    }

    /// Creates a replay policy with a caller-supplied safety proof.
    pub fn replayable(
        safety: RetrySafety,
        max_attempts: NonZeroU8,
        backoff: BackoffPolicy,
    ) -> Self {
        let max_attempts = if safety == RetrySafety::Never {
            NonZeroU8::MIN
        } else {
            max_attempts
        };
        Self {
            safety,
            max_attempts,
            backoff,
        }
    }

    pub fn safety(self) -> RetrySafety {
        self.safety
    }

    pub fn max_attempts(self) -> NonZeroU8 {
        self.max_attempts
    }

    pub fn backoff(self) -> BackoffPolicy {
        self.backoff
    }

    pub(crate) fn should_retry_response(self, attempts_completed: u8, status: u16) -> bool {
        self.can_start_another_attempt(attempts_completed)
            && matches!(status, 408 | 429 | 500 | 502 | 503 | 504)
    }

    pub(crate) fn should_retry_transport_error(self, attempts_completed: u8) -> bool {
        self.can_start_another_attempt(attempts_completed)
    }

    pub(crate) fn backoff_delay(self, attempts_completed: u8) -> Duration {
        self.backoff.delay_before_retry(attempts_completed - 1)
    }

    fn can_start_another_attempt(self, attempts_completed: u8) -> bool {
        self.safety != RetrySafety::Never && attempts_completed < self.max_attempts.get()
    }
}
