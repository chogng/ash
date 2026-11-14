use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactSourceDto {
    pub provider_id: String,
    pub account_id: Option<String>,
    pub session_id: String,
    pub thread_id: String,
    pub item_id: String,
    pub part_id: String,
}

/// Content has already been saved by the client's file service. A resource is
/// only a descriptor; registering it does not grant file access to any caller.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactRegistrationDto {
    /// Canonical lowercase SHA-256 hex ID chosen by the client.
    pub id: String,
    pub resource: String,
    pub title: String,
    pub content_type: String,
    pub source: ArtifactSourceDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactResourceDto {
    pub id: String,
    pub resource: String,
    pub title: String,
    pub content_type: String,
    pub source: ArtifactSourceDto,
    /// Unix milliseconds assigned by the store, preserved across retries.
    #[ts(type = "number")]
    pub created_at: i64,
}

/// clientId identifies a persistent UI storage namespace, independent of connections.
/// Retrying an ID with the same resource and source returns the original metadata;
/// reusing an ID or source with a different identity is a conflict.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactCatalogRegisterParams {
    pub client_id: String,
    pub file: ArtifactRegistrationDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactCatalogRegisterResult {
    pub file: ArtifactResourceDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactCatalogListParams {
    pub client_id: String,
    /// Active provider account scopes. Browser connections can only list native files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactCatalogListResult {
    pub files: Vec<ArtifactResourceDto>,
}

/// Invalidation only: subscribe before listing, and reread this namespace when
/// notified. Broadcast to initialized ProductHost connections after insertion.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactCatalogChanged {
    pub client_id: String,
}

#[cfg(test)]
#[path = "artifact_catalog_tests.rs"]
mod tests;
