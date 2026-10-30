use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

/// An observation of the profile secret facility; never contains credentials or key material.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SecretStorageStatus {
    Available,
    Unavailable,
    AccessDenied,
    KeyMissing,
    Corrupted,
    MigrationFailed,
    Failure,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SecretStorageStatusResult {
    pub status: SecretStorageStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<SecretStorageMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_type: Option<SecretStorageType>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum SecretStorageType {
    Persisted,
    InMemory,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SecretStorageMode {
    Encrypted,
    File,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretStorageModeSetParams {
    pub mode: SecretStorageMode,
}
