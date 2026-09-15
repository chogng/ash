use ash_protocol::SessionId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InstructionListParams {
    pub session_id: SessionId,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum InstructionScopeDto {
    User,
    Directory,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum InstructionLoadDto {
    Global,
    Contextual,
    OnDemand,
}

/// Metadata only; listing does not attach instruction bodies to a Turn.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InstructionDto {
    pub path: String,
    pub scope: InstructionScopeDto,
    pub name: String,
    pub description: Option<String>,
    pub load: InstructionLoadDto,
    pub patterns: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InstructionDiagnosticDto {
    pub path: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InstructionListResult {
    pub instructions: Vec<InstructionDto>,
    pub diagnostics: Vec<InstructionDiagnosticDto>,
}

/// Empty sources previews all discovered instructions from the selected source; otherwise select exact relative paths.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstructionImportPreviewParams {
    /// Selects both source layout and destination ownership; never inferred from a path.
    pub scope: InstructionScopeDto,
    pub source: InstructionImportSource,
    /// Authorized source root: project directory or external user home.
    pub directory: crate::protocol::environment::SessionDirSelector,
    pub sources: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum InstructionImportStatus {
    Ready,
    Unchanged,
    Conflict,
    Unsupported,
    Imported,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InstructionImportItem {
    pub source: String,
    pub target: String,
    pub content: String,
    pub status: InstructionImportStatus,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InstructionImportPreviewResult {
    /// Canonical destination root; item targets are relative to this directory.
    pub target_directory: std::path::PathBuf,
    pub digest: String,
    pub items: Vec<InstructionImportItem>,
    pub diagnostics: Vec<InstructionDiagnosticDto>,
}

/// Applies exactly a reviewed selection. A stale digest is rejected before any writes.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstructionImportParams {
    /// Selects both source layout and destination ownership; never inferred from a path.
    pub scope: InstructionScopeDto,
    pub source: InstructionImportSource,
    /// Authorized source root: project directory or external user home.
    pub directory: crate::protocol::environment::SessionDirSelector,
    pub sources: Vec<String>,
    pub digest: String,
}

/// Publication is atomic per file. Inspect every item; a failed item does not roll back earlier files.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InstructionImportResult {
    pub items: Vec<InstructionImportItem>,
}

/// External instruction format. No implicit default or runtime source registration.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum InstructionImportSource {
    Copilot,
    Claude,
    Codex,
    Cursor,
}
