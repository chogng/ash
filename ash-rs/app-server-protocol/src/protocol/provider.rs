use crate::JsonSchema;
use crate::TS;
use crate::protocol::model::ModelCatalogEntry;
use serde::Deserialize;
use serde::Serialize;
use std::fmt;
use zeroize::Zeroize;

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ProviderApiKeyPolicyDto {
    Unsupported,
    Optional,
    Required,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCatalogEntryDto {
    pub provider: String,
    pub display_name: String,
    pub api_key_policy: ProviderApiKeyPolicyDto,
    pub api_key_configured: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderListResult {
    pub providers: Vec<ProviderCatalogEntryDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelsListParams {
    pub provider: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ProviderModelsListFailureCodeDto {
    Authentication,
    Permission,
    Unsupported,
    RateLimited,
    Unreachable,
    ProviderUnavailable,
    InvalidRequest,
    InvalidResponse,
    InvalidConfiguration,
    Cancelled,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelsListFailureDto {
    pub code: ProviderModelsListFailureCodeDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProviderModelsListResult {
    Models {
        models: Vec<ModelCatalogEntry>,
    },
    Empty,
    Failed {
        failure: ProviderModelsListFailureDto,
    },
}

/// Inbound-only provider API key that redacts diagnostics and clears its allocation on drop.
#[derive(Deserialize, Eq, JsonSchema, PartialEq, TS)]
#[serde(transparent)]
pub struct ProviderApiKeyDto(String);

impl ProviderApiKeyDto {
    pub fn into_bytes(mut self) -> Vec<u8> {
        std::mem::take(&mut self.0).into_bytes()
    }
}

impl fmt::Debug for ProviderApiKeyDto {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProviderApiKeyDto([REDACTED])")
    }
}

impl Drop for ProviderApiKeyDto {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Debug, Deserialize, Eq, JsonSchema, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderApiKeySetParams {
    pub provider: String,
    pub api_key: ProviderApiKeyDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderApiKeySetResult {
    pub provider: String,
    pub api_key_configured: bool,
}

/// Tests an unsaved connection without changing configuration or stored credentials.
#[derive(Debug, Deserialize, Eq, JsonSchema, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProbeParams {
    pub config: crate::protocol::config::ProviderConfigDto,
    pub api_key: Option<ProviderApiKeyDto>,
    pub model: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProviderProbeResult {
    Passed,
    Models { models: Vec<String> },
    Failed { message: String },
}
