use crate::JsonSchema;
use crate::TS;
use crate::protocol::environment::SessionDirSelector;
use crate::protocol::resources::ResourceMetadataResult;
use serde::Deserialize;
use serde::Serialize;
use std::path::PathBuf;

/// Stable filesystem entry kind exposed to clients.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum FsFileType {
    Directory,
    File,
    SymbolicLink,
    Other,
}

/// Read metadata for one path relative to the configured directory root.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsGetMetadataParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
    pub path: PathBuf,
}

/// Metadata returned for one existing directory path.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsGetMetadataResult {
    pub file_type: FsFileType,
    #[ts(type = "number")]
    pub size_bytes: u64,
    pub readonly: bool,
    #[ts(type = "number | null")]
    pub modified_at_millis: Option<u64>,
}

/// List direct children for one directory relative to the configured directory root.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsReadDirectoryParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
    pub path: PathBuf,
}

/// One direct child returned by `fs/readDirectory`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsReadDirectoryEntry {
    pub name: String,
    pub file_type: FsFileType,
}

/// Direct children returned by `fs/readDirectory`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsReadDirectoryResult {
    pub entries: Vec<FsReadDirectoryEntry>,
}

/// Read one UTF-8 file relative to the configured directory root.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsReadFileParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
    pub path: PathBuf,
}

/// UTF-8 text returned by `fs/readFile`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsReadFileResult {
    pub content: String,
    /// Opaque exact-content revision required to protect a later conditional write.
    pub revision: String,
}

/// Read one binary file relative to the configured directory root.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsReadBinaryFileParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
    pub path: PathBuf,
}

/// Connection-owned binary resource opened from one directory file.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsReadBinaryFileResult {
    pub resource: ResourceMetadataResult,
    /// Opaque exact-content revision of the resource bytes.
    pub revision: String,
}

/// Atomically write one UTF-8 file relative to the configured directory root.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsWriteFileParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
    pub path: PathBuf,
    pub content: String,
    /// When supplied, rejects the write if the file no longer has this exact revision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub expected_revision: Option<String>,
}

/// Metadata returned after one successful `fs/writeFile`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsWriteFileResult {
    pub metadata: FsGetMetadataResult,
    /// Opaque exact-content revision of the successfully written file.
    pub revision: String,
}

/// Behavior when a create or rename target already exists.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum FsExistingTargetBehavior {
    Error,
    Overwrite,
    Ignore,
}

/// Behavior when a delete target does not exist.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum FsMissingTargetBehavior {
    Error,
    Ignore,
}

/// Scope of one delete operation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum FsDeleteMode {
    FileOrEmptyDirectory,
    Recursive,
}

/// Creates one empty directory file.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsCreateFileParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
    pub path: PathBuf,
    pub existing: FsExistingTargetBehavior,
}

/// Renames one directory file or directory.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsRenameParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
    pub source: PathBuf,
    pub target: PathBuf,
    pub existing: FsExistingTargetBehavior,
}

/// Deletes one directory file or directory.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsDeleteParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
    pub path: PathBuf,
    pub missing: FsMissingTargetBehavior,
    pub mode: FsDeleteMode,
}

/// Coarse directory filesystem invalidation published by `fs/changed`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
#[ts(tag = "type")]
pub enum FsChanged {
    /// The backend observed changes near these sorted directory-relative paths.
    PathsChanged {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[serde(rename = "dirId")]
        #[ts(optional)]
        #[ts(rename = "dirId")]
        dir_id: Option<String>,
        paths: Vec<PathBuf>,
    },
    /// The watcher may have lost events and consumers must rescan their visible scope.
    RescanRequired {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[serde(rename = "dirId")]
        #[ts(optional)]
        #[ts(rename = "dirId")]
        dir_id: Option<String>,
    },
}
