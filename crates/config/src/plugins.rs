use crate::ConfigError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub use plugin::PluginPackageId;
pub use plugin::PluginVersion;

/// Desired participation of a requested Plugin in future activation resolution.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum PluginRequestEnablement {
    #[default]
    Disabled,
    Enabled,
}

/// User request for one exact Plugin package.
///
/// This is desired configuration only. It does not install the package, grant capabilities,
/// bind credentials, or prove that activation succeeded.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginRequest {
    #[cfg_attr(feature = "schema", schemars(with = "String"))]
    pub plugin_id: PluginPackageId,
    #[cfg_attr(feature = "schema", schemars(with = "String"))]
    pub version: PluginVersion,
    #[serde(default)]
    pub enablement: PluginRequestEnablement,
}

/// User Plugin requests keyed by stable package identity.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginsConfig {
    #[serde(default)]
    #[cfg_attr(feature = "schema", schemars(with = "BTreeMap<String, PluginRequest>"))]
    pub requests: BTreeMap<PluginPackageId, PluginRequest>,
}

impl PluginsConfig {
    pub(crate) fn validate(&self) -> Result<(), ConfigError> {
        validate_request_keys(&self.requests, "User")
    }
}

/// Scope requested by a directory Plugin request.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum DirPluginRequestScope {
    #[default]
    Directory,
}

/// A non-authoritative directory request for an exact Plugin package.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirPluginRequest {
    #[cfg_attr(feature = "schema", schemars(with = "String"))]
    pub plugin_id: PluginPackageId,
    #[cfg_attr(feature = "schema", schemars(with = "String"))]
    pub version: PluginVersion,
    #[serde(default)]
    pub requested_scope: DirPluginRequestScope,
}

/// Directory Plugin requests keyed by stable package identity.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirPluginRequests {
    #[serde(default)]
    #[cfg_attr(
        feature = "schema",
        schemars(with = "BTreeMap<String, DirPluginRequest>")
    )]
    pub requests: BTreeMap<PluginPackageId, DirPluginRequest>,
}

impl DirPluginRequests {
    pub(crate) fn validate(&self) -> Result<(), ConfigError> {
        for (plugin_id, request) in &self.requests {
            if &request.plugin_id != plugin_id {
                return Err(ConfigError(format!(
                    "directory Plugin request '{}' contains request for '{}'",
                    plugin_id, request.plugin_id
                )));
            }
        }
        Ok(())
    }
}

fn validate_request_keys(
    requests: &BTreeMap<PluginPackageId, PluginRequest>,
    scope: &str,
) -> Result<(), ConfigError> {
    for (plugin_id, request) in requests {
        if &request.plugin_id != plugin_id {
            return Err(ConfigError(format!(
                "{scope} Plugin request '{}' contains request for '{}'",
                plugin_id, request.plugin_id
            )));
        }
    }
    Ok(())
}
