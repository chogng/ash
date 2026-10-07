use serde::Deserialize;
use serde::Serialize;

/// Refresh preferences for the Issue browser. Agent execution uses ordinary Session settings.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IssueConfig {
    #[serde(default = "default_refresh_minutes")]
    pub auto_refresh_minutes: u32,
}

fn default_refresh_minutes() -> u32 {
    10
}

impl Default for IssueConfig {
    fn default() -> Self {
        Self {
            auto_refresh_minutes: default_refresh_minutes(),
        }
    }
}
