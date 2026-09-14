use ash_protocol::InstructionRef;
use ash_protocol::InstructionSource;
use ash_protocol::SessionId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::path::PathBuf;
use ts_rs::TS;

/// Selected Ash destination and its corresponding Claude source scope.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum InstructionImportScopeDto {
    User,
    Workspace,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InstructionImportPreviewParams {
    pub scope: InstructionImportScopeDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InstructionImportSourceDto {
    pub relative_path: PathBuf,
    pub content: String,
    pub sha256: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum InstructionImportDiagnosticCodeDto {
    MetadataUnavailable,
    UnexpectedFileType,
    SymlinkNotAllowed,
    EscapesSelectedRoot,
    InvalidContent,
    LimitExceeded,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InstructionImportDiagnosticDto {
    pub relative_path: PathBuf,
    pub code: InstructionImportDiagnosticCodeDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InstructionImportPreviewResult {
    pub source: Option<InstructionImportSourceDto>,
    pub target: PathBuf,
    pub target_conflict: bool,
    pub diagnostics: Vec<InstructionImportDiagnosticDto>,
}

/// The user confirms the exact previewed source bytes and source path.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InstructionImportApplyParams {
    pub scope: InstructionImportScopeDto,
    pub relative_path: PathBuf,
    pub expected_sha256: String,
    pub expected_target: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InstructionImportApplyResult {
    pub target: PathBuf,
    pub sha256: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InstructionListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_id: Option<SessionId>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum InstructionLoadPolicyDto {
    Global,
    Contextual,
    OnDemand,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InstructionDto {
    pub reference: InstructionRef,
    pub name: String,
    pub load_policy: InstructionLoadPolicyDto,
    pub path: PathBuf,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum InstructionDiagnosticCodeDto {
    SourceUnavailable,
    EntryLimitExceeded,
    UnsupportedFileType,
    SymlinkNotAllowed,
    InvalidName,
    InvalidFrontmatter,
    InvalidLoadPolicy,
    ContentTooLarge,
    ContentInvalidUtf8,
    EmptyBody,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InstructionCatalogDiagnosticDto {
    pub source: InstructionSource,
    pub relative_path: Option<PathBuf>,
    pub code: InstructionDiagnosticCodeDto,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InstructionListResult {
    pub instructions: Vec<InstructionDto>,
    pub diagnostics: Vec<InstructionCatalogDiagnosticDto>,
}
