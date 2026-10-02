use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetImportStartParams {
    pub asset_id: String,
    pub version_id: String,
    pub name: String,
    pub source: String,
    pub size: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AssetImportStartResult {
    pub max_chunk_bytes: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetImportWriteParams {
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
    pub version_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetVersionParams {
    pub asset_id: String,
    pub version_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AssetVersionResult {
    pub asset_id: String,
    pub version_id: String,
    pub name: String,
    pub source: String,
    pub sha256: String,
    pub media_type: AssetImageType,
    pub size: usize,
    pub width: u32,
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
    pub asset_id: String,
    pub version_id: String,
    pub offset: usize,
    #[schemars(range(min = 1, max = 196608))]
    pub max_bytes: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AssetReadResult {
    pub data_base64: String,
    pub offset: usize,
    pub decoded_length: usize,
    pub eof: bool,
}
