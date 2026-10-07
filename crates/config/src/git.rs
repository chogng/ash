use serde::Deserialize;
use serde::Serialize;

/// Which remotes the shared Git runtime fetches automatically.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum GitAutoFetchMode {
    #[default]
    Off,
    Default,
    All,
}

/// Profile-wide automatic Git fetch preference, interpreted by App Server.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitConfig {
    #[serde(default)]
    pub autofetch: GitAutoFetchMode,
    #[serde(default = "default_period")]
    pub autofetch_period: u32,
}

impl Default for GitConfig {
    fn default() -> Self {
        Self {
            autofetch: GitAutoFetchMode::Off,
            autofetch_period: default_period(),
        }
    }
}

impl GitConfig {
    pub(crate) fn validate(self) -> Result<(), crate::ConfigError> {
        if !(1..=86_400).contains(&self.autofetch_period) {
            return Err(crate::ConfigError(
                "git.autofetchPeriod must be an integer from 1 to 86400 seconds".into(),
            ));
        }
        Ok(())
    }
}

const fn default_period() -> u32 {
    180
}
