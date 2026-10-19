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
    #[serde(alias = "marketplace")]
    Registry,
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

/// Trusted source metadata linking one runtime authority package to catalog resources.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionRuntimeBindingDto {
    #[schemars(length(min = 1, max = 256))]
    pub runtime_id: String,
    #[schemars(length(min = 71, max = 71))]
    pub package_digest: String,
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
    /// File URI of the exact package directory on the extension execution host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub extension_location: Option<String>,
    /// Execution host OS and architecture, independent of the renderer platform.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub target_platform: Option<String>,
    pub manifest_json: String,
    pub manifest_sha256: String,
    pub package_sha256: String,
    /// Set only by the effective Plugin authority for its standard JavaScript package.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub runtime_binding: Option<ExtensionRuntimeBindingDto>,
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

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionGalleryResult {
    pub resource_url_template: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionGalleryResourceOpenParams {
    /// Expected configured gallery, fencing a reconnect or source change between URL resolution and reading.
    pub resource_url_template: String,
    pub publisher: String,
    pub name: String,
    pub version: String,
    /// Portable path relative to the extension directory in the verified VSIX.
    pub path: String,
}

#[cfg(test)]
#[path = "extensions_tests.rs"]
mod tests;
