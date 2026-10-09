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

/// Lookup behavior observed on the target filesystem, independent of the server process OS.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum FsPathCaseSensitivity {
    Sensitive,
    Insensitive,
    Unknown,
}

/// Observe the existing directory ancestors of a relative path, including a missing destination.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsReadPathCaseSensitivityParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
    pub path: PathBuf,
}

/// One directory-relative scope; the rule applies only to its direct children's names.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsPathCaseSensitivityScope {
    pub path: PathBuf,
    pub sensitivity: FsPathCaseSensitivity,
}

/// Scopes ordered from the granted root (".") to the deepest existing directory.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsReadPathCaseSensitivityResult {
    pub scopes: Vec<FsPathCaseSensitivityScope>,
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

/// Write exact bytes, with legacy paste semantics when no explicit options are supplied.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsWriteBinaryFileParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
    pub path: PathBuf,
    pub data_base64: String,
    /// When absent, keeps legacy paste behavior: only missing or empty targets may be written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub options: Option<FsFileWriteOptions>,
}

/// One explicit administrator save. A missing revision may only create an absent file.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsWriteFileElevatedParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
    pub path: PathBuf,
    pub data_base64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub expected_revision: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsCancelElevatedWriteParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
}

/// Explicit publication policy and optional exact-content revision for byte writes.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsFileWriteOptions {
    pub mode: FsFileWriteMode,
    /// Explicit editor retry; requires an existing target and its exact revision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub unlock: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub expected_revision: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum FsFileWriteMode {
    Create,
    Replace,
    CreateOrReplace,
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

/// Creates one workspace directory.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsCreateDirectoryParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
    pub path: PathBuf,
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

/// Copies between workspace roots, or within one Session-authorized directory.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsCopyParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_dir_id: Option<String>,
    pub source: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub target_dir_id: Option<String>,
    pub target: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
}

/// Pastes files from the system clipboard into a granted workspace directory.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsPasteSystemFilesParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_directory: Option<SessionDirSelector>,
    pub path: PathBuf,
    pub move_requested: bool,
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
