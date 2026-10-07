use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResourceMetadataParams {
    #[schemars(length(min = 1))]
    pub resource_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResourceMetadataResult {
    pub resource_id: String,
    pub mime_type: String,
    pub size: usize,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResourceReadParams {
    #[schemars(length(min = 1))]
    pub resource_id: String,
    pub offset: usize,
    #[schemars(range(min = 1, max = 262144))]
    pub max_bytes: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResourceReadResult {
    pub resource_id: String,
    pub offset: usize,
    pub data_base64: String,
    #[schemars(range(max = 262144))]
    pub decoded_length: usize,
    pub eof: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResourceReleaseParams {
    #[schemars(length(min = 1))]
    pub resource_id: String,
}
