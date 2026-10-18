use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

/// Immutable renderer-captured context. Handles are meaningful only on their originating connection.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostResourceRef {
    #[schemars(length(min = 1, max = 128))]
    pub handle: String,
    #[schemars(range(min = 1, max = 8388608))]
    pub byte_length: usize,
    #[schemars(length(min = 71, max = 71))]
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostResourceReadParams {
    #[schemars(length(min = 1, max = 128))]
    pub handle: String,
    #[schemars(range(max = 8388608))]
    pub offset: usize,
    #[schemars(range(min = 1, max = 262144))]
    pub max_bytes: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostResourceReadResult {
    #[schemars(length(min = 1, max = 128))]
    pub handle: String,
    #[schemars(range(max = 8388608))]
    pub offset: usize,
    #[schemars(length(max = 349528))]
    pub data_base64: String,
    #[schemars(range(min = 1, max = 262144))]
    pub decoded_length: usize,
    pub eof: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostResourceReleaseParams {
    #[schemars(length(min = 1, max = 128))]
    pub handle: String,
}
