use crate::JsonSchema;
use crate::TS;
use crate::protocol::common::CommandId;
use crate::protocol::common::SessionId;
use ash_environment::EnvId;
use ash_file_access::DirId;
use ash_protocol::ProjectId;
use ash_utils_path_uri::PathUri;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ProjectStatusDto {
    Active,
    Archived,
    Deleted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ProjectScopeDto {
    Chat,
    Code,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRootDto {
    pub environment_id: EnvId,
    pub dir_id: DirId,
    /// Absolute file location in the root's environment; this does not grant access.
    pub path: PathUri,
    pub name: String,
    pub purpose: String,
}

/// An organizational reference, without any authorization to read the source.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectMaterialDto {
    pub path: PathUri,
    pub name: String,
    pub kind: ProjectMaterialKindDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ProjectMaterialKindDto {
    File,
    Folder,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDto {
    pub project_id: ProjectId,
    #[ts(type = "number")]
    pub revision: u64,
    /// Unix epoch milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub created_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub updated_at_ms: Option<u64>,
    pub status: ProjectStatusDto,
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    pub roots: Vec<ProjectRootDto>,
    pub session_ids: Vec<SessionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub external_conversation_ids: Option<Vec<String>>,
    pub materials: Vec<ProjectMaterialDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummaryDto {
    pub project_id: ProjectId,
    #[ts(type = "number")]
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub created_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub updated_at_ms: Option<u64>,
    pub status: ProjectStatusDto,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    #[ts(type = "number")]
    pub root_count: u64,
    #[ts(type = "number")]
    pub session_count: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ProjectListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scope: Option<ProjectScopeDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListResult {
    pub projects: Vec<ProjectSummaryDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectReadParams {
    pub project_id: ProjectId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scope: Option<ProjectScopeDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectReadResult {
    pub project: ProjectDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectCreateParams {
    #[serde(default)]
    pub materials: Vec<ProjectMaterialDto>,
    pub command_id: CommandId,
    pub project_id: ProjectId,
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scope: Option<ProjectScopeDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectDetailsUpdateParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub materials: Option<Vec<ProjectMaterialDto>>,
    pub command_id: CommandId,
    pub project_id: ProjectId,
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub name: String,
    pub description: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ProjectAppearanceFieldDto {
    Icon,
    Color,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectAppearanceUpdateParams {
    pub command_id: CommandId,
    pub project_id: ProjectId,
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub field: ProjectAppearanceFieldDto,
    #[ts(type = "string | null")]
    pub value: Option<String>,
}

/// Adds only a root already known to the exact Session directory scope.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRootAddParams {
    pub command_id: CommandId,
    pub project_id: ProjectId,
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub session_id: SessionId,
    pub dir_id: DirId,
    pub name: String,
    pub purpose: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRootUpdateParams {
    pub command_id: CommandId,
    pub project_id: ProjectId,
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub dir_id: DirId,
    pub name: String,
    pub purpose: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRootRemoveParams {
    pub command_id: CommandId,
    pub project_id: ProjectId,
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub dir_id: DirId,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSessionMutationParams {
    pub command_id: CommandId,
    pub project_id: ProjectId,
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub session_id: SessionId,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ProjectConversationMembership {
    Link,
    Unlink,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectConversationMembershipParams {
    pub command_id: CommandId,
    pub project_id: ProjectId,
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub conversation_id: String,
    pub membership: ProjectConversationMembership,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectLifecycleParams {
    pub command_id: CommandId,
    pub project_id: ProjectId,
    #[ts(type = "number")]
    pub expected_revision: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ProjectCommandDispositionDto {
    Committed,
    Replayed,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMutationResult {
    pub disposition: ProjectCommandDispositionDto,
    pub project: ProjectDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChanged {
    pub project: ProjectDto,
}
