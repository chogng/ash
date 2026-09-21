use crate::JsonSchema;
use crate::TS;
use crate::protocol::resources::ResourceMetadataResult;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionCatalogReloadDto {
    #[default]
    Cached,
    Refresh,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionSourceKindDto {
    BuiltIn,
    Plugin,
    Marketplace,
    User,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionDiagnosticCodeDto {
    SourceUnavailable,
    InvalidManifest,
    DuplicateExtension,
    PathEscapesRoot,
    ResourceNotFound,
    ResourceTooLarge,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionDto {
    pub id: String,
    pub name: String,
    pub publisher: String,
    pub version: String,
    pub display_name: String,
    pub source_kind: ExtensionSourceKindDto,
    pub manifest_json: String,
    pub manifest_sha256: String,
    pub package_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionDiagnosticDto {
    pub source: String,
    pub subject: Option<String>,
    pub code: ExtensionDiagnosticCodeDto,
    pub message: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionListParams {
    #[serde(default)]
    pub reload: ExtensionCatalogReloadDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionListResult {
    #[ts(type = "number")]
    pub generation: u64,
    pub extensions: Vec<ExtensionDto>,
    pub diagnostics: Vec<ExtensionDiagnosticDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionResourceOpenParams {
    #[ts(type = "number")]
    pub generation: u64,
    pub extension_id: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionResourceOpenResult {
    pub resource: ResourceMetadataResult,
}
