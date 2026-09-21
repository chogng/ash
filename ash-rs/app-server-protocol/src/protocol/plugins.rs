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
    pub enabled: bool,
    pub granted: bool,
    pub effective: bool,
    pub revoked: bool,
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
