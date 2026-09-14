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
