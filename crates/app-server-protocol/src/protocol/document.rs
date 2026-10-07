use crate::JsonSchema;
use crate::TS;
use crate::protocol::resources::ResourceMetadataResult;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TypstCompileParams {
    pub source: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum TypstCompileResult {
    Success {
        resource: ResourceMetadataResult,
        warnings: Vec<TypstDiagnosticDto>,
    },
    Failed {
        diagnostics: Vec<TypstDiagnosticDto>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TypstDiagnosticDto {
    pub severity: TypstDiagnosticSeverityDto,
    pub message: String,
    pub hints: Vec<String>,
    pub range: Option<TypstSourceRangeDto>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TypstDiagnosticSeverityDto {
    Error,
    Warning,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TypstSourceRangeDto {
    pub start: usize,
    pub end: usize,
}
