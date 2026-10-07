use crate::CoreError;
use ash_protocol::TimeContext;

/// Supplies immutable time facts from the host's current profile policy.
/// Implementations must return no context for off and report sampling/zone errors explicitly.
pub trait TimeContextProvider: Send + Sync {
    fn snapshot(&self) -> Result<Option<TimeContext>, CoreError>;
}

pub(crate) struct NoTimeContext;

impl TimeContextProvider for NoTimeContext {
    fn snapshot(&self) -> Result<Option<TimeContext>, CoreError> {
        Ok(None)
    }
}
