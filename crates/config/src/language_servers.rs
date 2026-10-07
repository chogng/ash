use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::ConfigError;

/// Stable configuration identity for one language-server integration.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(transparent)]
pub struct LanguageServerId(String);

impl LanguageServerId {
    pub fn new(value: impl Into<String>) -> Result<Self, ConfigError> {
        let value = value.into();
        let valid = !value.is_empty()
            && value.len() <= 64
            && !value.starts_with('-')
            && !value.ends_with('-')
            && value
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
        if !valid {
            return Err(ConfigError(
                "language server id must be 1-64 lowercase ASCII letters, digits, or hyphens"
                    .into(),
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for LanguageServerId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for LanguageServerId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// Durable user intent for one language server.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum LanguageServerModeConfig {
    Disabled,
    #[default]
    Enabled,
}

/// Runtime-free language-server preference stored by the User Config authority.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguageServerConfig {
    #[serde(default)]
    pub mode: LanguageServerModeConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable: Option<PathBuf>,
}

impl LanguageServerConfig {
    pub(crate) fn validate(&self) -> Result<(), ConfigError> {
        if let Some(executable) = &self.executable
            && !executable.is_absolute()
        {
            return Err(ConfigError(
                "language server executable override must be an absolute path".into(),
            ));
        }
        Ok(())
    }
}

/// User-owned language-server preferences keyed by stable integration identity.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguageServersConfig {
    #[serde(default)]
    pub servers: BTreeMap<LanguageServerId, LanguageServerConfig>,
}

impl LanguageServersConfig {
    pub(crate) fn validate(&self) -> Result<(), ConfigError> {
        for server in self.servers.values() {
            server.validate()?;
        }
        Ok(())
    }
}
