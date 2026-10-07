use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

/// Recovery namespaces are stable across restarts, independent of connection or window IDs.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupWorkspacesParams {
    pub client_id: String,
}

/// Reopening URIs identify a workspace; they do not grant filesystem access.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupWorkspaceDto {
    pub id: String,
    pub folders: Vec<String>,
    pub configuration: Option<String>,
    pub remote_authority: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BackupWorkspacesResult {
    pub workspaces: Vec<BackupWorkspaceDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupListParams {
    pub client_id: String,
    pub workspace_id: String,
}

/// Opaque UTF-8 content is serialized and interpreted by its format owner.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupContentDto {
    pub resource: String,
    pub format: String,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BackupRecordDto {
    pub content: BackupContentDto,
    pub revision: String,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BackupListResult {
    pub backups: Vec<BackupRecordDto>,
}

/// Null creates a record; updates require the observed revision. Identical retries are safe.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupWriteParams {
    pub client_id: String,
    pub workspace: BackupWorkspaceDto,
    pub content: BackupContentDto,
    pub expected_revision: Option<String>,
}

/// Saving or reverting removes only the version previously observed by that writer.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupDiscardParams {
    pub client_id: String,
    pub workspace_id: String,
    pub resource: String,
    pub expected_revision: String,
}
