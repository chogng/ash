use ash_config::ConfigStore;
use ash_core::TimeContextProvider;
use ash_protocol::TimeContext;
use ash_protocol::TimeContextMode;
use ash_protocol::TimeZoneOrigin;
use ash_protocol::UnixMillis;
use core_api::CoreError;
use std::sync::Arc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

/// Profile-scoped clock policy, shared by input acceptance and model request preparation.
pub(crate) struct ConfigTimeContext {
    config: Arc<ConfigStore>,
}

impl ConfigTimeContext {
    pub(crate) fn new(config: Arc<ConfigStore>) -> Self {
        Self { config }
    }
}

impl TimeContextProvider for ConfigTimeContext {
    fn snapshot(&self) -> Result<Option<TimeContext>, CoreError> {
        let config = self
            .config
            .read_snapshot()
            .map_err(|error| CoreError::Context(error.to_string()))?
            .values
            .time_context;
        if config.mode == TimeContextMode::Off {
            return Ok(None);
        }
        let (time_zone, origin) = match config.time_zone {
            Some(zone) => (zone, TimeZoneOrigin::Configured),
            None => (
                iana_time_zone::get_timezone().map_err(|error| {
                    CoreError::Context(format!("cannot determine host time zone: {error}"))
                })?,
                TimeZoneOrigin::Host,
            ),
        };
        let sampled = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| CoreError::Context(error.to_string()))?
            .as_millis();
        let sampled = u64::try_from(sampled)
            .map_err(|_| CoreError::Context("clock timestamp is out of range".into()))?;
        let snapshot = ash_agent_environment::TimeSnapshot::capture(
            UnixMillis::new(sampled).map_err(|error| CoreError::Context(error.into()))?,
            time_zone,
            origin,
            config.mode,
        )
        .map_err(|error| CoreError::Context(error.to_string()))?;
        Ok(Some(snapshot.facts().clone()))
    }
}

#[cfg(test)]
#[path = "time_context_tests.rs"]
mod tests;
