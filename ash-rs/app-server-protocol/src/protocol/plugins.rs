use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

/// Exact installed package plus each independent Plugin authority layer.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginPackageDto {
    pub id: String,
    pub version: String,
    pub digest: String,
    pub display_name: String,
    pub permissions: Vec<PluginPermissionDto>,
    pub has_editor_extensions: bool,
    pub enabled: bool,
    pub granted: bool,
    pub effective: bool,
    pub revoked: bool,
}

/// Declared maximum permissions of the exact installed package, shown before granting it.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PluginPermissionDto {
    Directory { access: PluginDirectoryAccessDto },
    Process { executable: String },
    Network { hosts: Vec<String> },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PluginDirectoryAccessDto {
    Read,
    Write,
}

/// Copies a package inside a currently authorized directory into the profile package store.
/// Installation alone neither enables the package nor grants its requested permissions.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallLocalParams {
    pub command_id: String,
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub path: String,
    pub dir_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallLocalResult {
    pub id: String,
    pub version: String,
    pub digest: String,
    pub command: PluginCommandResultDto,
}

/// Current durable Plugin authority projection.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginListResult {
    #[ts(type = "number")]
    pub revision: u64,
    #[ts(type = "number")]
    pub activation_generation: u64,
    pub packages: Vec<PluginPackageDto>,
}

/// Exact package target for retry-safe Plugin lifecycle commands.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginPackageCommandParams {
    pub command_id: String,
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub id: String,
    pub version: String,
    pub digest: String,
}

/// Result of one committed or exactly replayed Plugin authority command.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommandResultDto {
    #[ts(type = "number")]
    pub revision: u64,
    #[ts(type = "number")]
    pub activation_generation: u64,
    pub disposition: PluginCommandDispositionDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PluginCommandDispositionDto {
    Updated,
    Replayed,
}

/// Notification emitted for every committed Plugin authority revision.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginsChanged {
    #[ts(type = "number")]
    pub revision: u64,
    #[ts(type = "number")]
    pub activation_generation: u64,
}
