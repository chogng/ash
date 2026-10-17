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
    /// Empty uses the integration's declared route; custom servers must supply a route.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub language_ids: Vec<String>,
    /// Appended to the integration's launch arguments; no shell expansion is performed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub environment: BTreeMap<String, String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_initialization_options",
        deserialize_with = "deserialize_initialization_options"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "Option<String>"))]
    pub initialization_options: Option<serde_json::Value>,
    /// Complete workspace/configuration settings object, keyed by section.
    #[serde(
        default,
        skip_serializing_if = "BTreeMap::is_empty",
        serialize_with = "serialize_settings",
        deserialize_with = "deserialize_settings"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "String"))]
    pub settings: BTreeMap<String, serde_json::Value>,
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
        let mut languages = std::collections::BTreeSet::new();
        if self.language_ids.len() > 64
            || self.language_ids.iter().any(|id| {
                id.is_empty()
                    || id.len() > 128
                    || !languages.insert(id)
                    || !id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"_+.-".contains(&byte))
            })
            || self.args.len() > 128
            || self
                .args
                .iter()
                .any(|arg| arg.len() > 16_384 || arg.contains('\0'))
            || self.environment.len() > 128
            || self.environment.iter().any(|(name, value)| {
                name.is_empty()
                    || name.len() > 256
                    || name.contains(['=', '\0'])
                    || value.len() > 16_384
                    || value.contains('\0')
            })
            || serde_json::to_vec(&(&self.initialization_options, &self.settings))
                .map_or(true, |bytes| bytes.len() > 256 * 1024)
        {
            return Err(ConfigError(
                "invalid or oversized language server configuration".into(),
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

// TOML cannot represent JSON null or heterogeneous JSON arrays losslessly. The profile stores
// these protocol-owned payloads as JSON strings; the Config domain and RPC retain parsed values.
fn serialize_initialization_options<S: serde::Serializer>(
    value: &Option<serde_json::Value>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let text = serde_json::to_string(value).map_err(serde::ser::Error::custom)?;
    serializer.serialize_str(&text)
}
fn deserialize_initialization_options<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<serde_json::Value>, D::Error> {
    let text = String::deserialize(deserializer)?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(serde::de::Error::custom)
}
fn serialize_settings<S: serde::Serializer>(
    value: &BTreeMap<String, serde_json::Value>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let text = serde_json::to_string(value).map_err(serde::ser::Error::custom)?;
    serializer.serialize_str(&text)
}
fn deserialize_settings<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<BTreeMap<String, serde_json::Value>, D::Error> {
    let text = String::deserialize(deserializer)?;
    serde_json::from_str(&text).map_err(serde::de::Error::custom)
}
