use crate::ConfigError;
use ash_protocol::TimeContextMode;
use serde::Deserialize;
use serde::Serialize;

/// Profile-owned policy for model time information; timers are independent of this setting.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeContextConfig {
    #[serde(default)]
    pub mode: TimeContextMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
}

impl TimeContextConfig {
    pub fn validate(&self) -> Result<(), ConfigError> {
        if let Some(zone) = &self.time_zone {
            ash_agent_environment::validate_time_zone(zone)
                .map_err(|error| ConfigError(error.to_string()))?;
        }
        Ok(())
    }
}
