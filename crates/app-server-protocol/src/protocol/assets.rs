use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetImportStartParams {
    #[schemars(length(min = 36, max = 36))]
    pub asset_id: String,
    #[schemars(length(min = 36, max = 36))]
    pub version_id: String,
    #[schemars(length(min = 1, max = 512))]
    pub name: String,
    #[schemars(length(min = 1, max = 8192))]
    pub source: String,
    #[schemars(range(min = 1, max = 16777216))]
    pub size: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AssetImportStartResult {
    #[schemars(range(min = 1, max = 196608))]
    pub max_chunk_bytes: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetImportWriteParams {
    #[schemars(length(min = 36, max = 36))]
    pub version_id: String,
    pub offset: usize,
    #[schemars(length(max = 262144))]
    pub data_base64: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AssetImportWriteResult {
    pub next_offset: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetImportParams {
    #[schemars(length(min = 36, max = 36))]
    pub version_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetVersionParams {
    #[schemars(length(min = 36, max = 36))]
    pub asset_id: String,
    #[schemars(length(min = 36, max = 36))]
    pub version_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AssetVersionResult {
    #[schemars(length(min = 36, max = 36))]
    pub asset_id: String,
    #[schemars(length(min = 36, max = 36))]
    pub version_id: String,
    #[schemars(length(min = 1, max = 512))]
    pub name: String,
    #[schemars(length(min = 1, max = 8192))]
    pub source: String,
    #[schemars(length(min = 64, max = 64))]
    pub sha256: String,
    pub media_type: AssetImageType,
    #[schemars(range(min = 1, max = 16777216))]
    pub size: usize,
    #[schemars(range(min = 1, max = 32768))]
    pub width: u32,
    #[schemars(range(min = 1, max = 32768))]
    pub height: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
pub enum AssetImageType {
    #[serde(rename = "image/png")]
    Png,
    #[serde(rename = "image/jpeg")]
    Jpeg,
    #[serde(rename = "image/webp")]
    Webp,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetReadParams {
    #[schemars(length(min = 36, max = 36))]
    pub asset_id: String,
    #[schemars(length(min = 36, max = 36))]
    pub version_id: String,
    pub offset: usize,
    #[schemars(range(min = 1, max = 196608))]
    pub max_bytes: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AssetReadResult {
    #[schemars(length(max = 262144))]
    pub data_base64: String,
    pub offset: usize,
    #[schemars(range(max = 196608))]
    pub decoded_length: usize,
    pub eof: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetCatalogParams {}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AssetCatalogEntry {
    pub version: AssetVersionResult,
    pub added_at: i64,
    pub favorite: bool,
    pub collection_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetCollection {
    #[schemars(length(min = 36, max = 36))]
    pub id: String,
    #[schemars(length(min = 1, max = 512))]
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AssetCatalogResult {
    pub entries: Vec<AssetCatalogEntry>,
    pub collections: Vec<AssetCollection>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetCatalogUpdateParams {
    #[schemars(length(min = 36, max = 36))]
    pub asset_id: String,
    pub favorite: bool,
    #[schemars(length(max = 64))]
    pub collection_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetCollectionDeleteParams {
    #[schemars(length(min = 36, max = 36))]
    pub id: String,
}
