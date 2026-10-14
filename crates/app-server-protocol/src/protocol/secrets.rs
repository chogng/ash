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
}
