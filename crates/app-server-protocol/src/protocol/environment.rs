use crate::JsonSchema;
use crate::TS;
use ash_protocol::CommandId;
use ash_protocol::SessionId;
use serde::Deserialize;
use serde::Serialize;
use std::path::PathBuf;

/// Explicit directory permission transported by the App Server protocol.
#[derive(
    Clone, Copy, Debug, Deserialize, Eq, JsonSchema, Ord, PartialEq, PartialOrd, Serialize, TS,
)]
#[serde(rename_all = "camelCase")]
pub enum PermissionDto {
    ReadFiles,
    WriteFiles,
    ExecuteCommands,
    WatchFiles,
    BrowseFiles,
    SearchFiles,
    LoadInstructions,
    LoadConfig,
    DiscoverSkills,
    DiscoverMcp,
    UseLanguageServices,
    DiscoverHooks,
    DiscoverPlugins,
    InspectRepository,
    MutateRepository,
}

/// Source of the grant attached while selecting an environment directory.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum DirGrantDto {
    Config,
    Host {
        permissions: Vec<PermissionDto>,
    },
    User {
        command_id: CommandId,
        #[schemars(range(min = 0))]
        #[ts(type = "number")]
        expected_revision: u64,
        permissions: Vec<PermissionDto>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionDirSelector {
    pub session_id: SessionId,
    pub path: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EnvDirSetEntry {
    pub id: String,
    pub path: PathBuf,
    pub grant: DirGrantDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EnvDirsSetParams {
    pub dirs: Vec<EnvDirSetEntry>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EnvDirDto {
    pub id: String,
    pub path: PathBuf,
    pub permissions: Vec<PermissionDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EnvDirsSetResult {
    pub dirs: Vec<EnvDirDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionDirDto {
    pub path: PathBuf,
    pub permissions: Vec<PermissionDto>,
    #[serde(default)]
    pub contributions: DirContributionsDto,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DirContributionsDto {
    pub skills: Vec<String>,
    pub mcp_servers: Vec<String>,
    pub hooks: Vec<String>,
    pub plugins: Vec<String>,
    pub diagnostics: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionDirListParams {
    pub session_id: SessionId,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionDirListResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub dirs: Vec<SessionDirDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionDirAddParams {
    pub session_id: SessionId,
    pub path: PathBuf,
    pub permissions: Vec<PermissionDto>,
}

/// Selects one Session execution directory and adds its explicit Session grant.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionDirMoveParams {
    pub session_id: SessionId,
    pub path: PathBuf,
    pub permissions: Vec<PermissionDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionDirMoveResult {
    pub cwd: PathBuf,
    #[ts(type = "number")]
    pub revision: u64,
    pub dirs: Vec<SessionDirDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionDirPermissionsSetParams {
    pub session_id: SessionId,
    pub path: PathBuf,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub permissions: Vec<PermissionDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionDirRemoveParams {
    pub session_id: SessionId,
    pub path: PathBuf,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SessionDirMutationDto {
    Added,
    AlreadyPresent,
    Removed,
    Updated,
    NotPresent,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionDirAddResult {
    /// Canonical path resolved by the server, including for an existing directory.
    pub path: PathBuf,
    pub mutation: SessionDirMutationDto,
    #[ts(type = "number")]
    pub revision: u64,
    pub dirs: Vec<SessionDirDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionDirMutationResult {
    pub mutation: SessionDirMutationDto,
    #[ts(type = "number")]
    pub revision: u64,
    pub dirs: Vec<SessionDirDto>,
}
