use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::secrets::SecretStorageStatus;
use ash_app_server_protocol::protocol::secrets::SecretStorageStatusResult;
use ash_secrets::SecretStoreErrorKind;
use serde_json::Value;

use super::AppServer;
use super::RpcError;
use super::decode;
use super::result;

impl AppServer {
    pub(super) fn secrets_status(&self, params: &Value) -> Result<Value, RpcError> {
        let _: ash_app_server_protocol::protocol::common::EmptyParams = decode(params)?;
        let status = match &self.secret_store {
            Some(store) => match store.check_availability() {
                Ok(()) => SecretStorageStatus::Available,
                Err(error) => storage_status(error.kind()),
            },
            None => SecretStorageStatus::Unavailable,
        };
        result(&SecretStorageStatusResult { status })
    }
}

fn storage_status(kind: SecretStoreErrorKind) -> SecretStorageStatus {
    match kind {
        SecretStoreErrorKind::BackendUnavailable => SecretStorageStatus::Unavailable,
        SecretStoreErrorKind::AccessDenied => SecretStorageStatus::AccessDenied,
        SecretStoreErrorKind::BackendFailure => SecretStorageStatus::Failure,
        SecretStoreErrorKind::KeyMissing => SecretStorageStatus::KeyMissing,
        SecretStoreErrorKind::InvalidData => SecretStorageStatus::Corrupted,
        SecretStoreErrorKind::MigrationFailed => SecretStorageStatus::MigrationFailed,
    }
}

pub(super) fn storage_error(kind: SecretStoreErrorKind) -> RpcError {
    let name = match kind {
        SecretStoreErrorKind::BackendUnavailable => AppServerErrorName::SecretStorageUnavailable,
        SecretStoreErrorKind::AccessDenied => AppServerErrorName::SecretStorageAccessDenied,
        SecretStoreErrorKind::BackendFailure => AppServerErrorName::SecretStorageOperationFailed,
        SecretStoreErrorKind::KeyMissing => AppServerErrorName::SecretStorageKeyMissing,
        SecretStoreErrorKind::InvalidData => AppServerErrorName::SecretStorageCorrupted,
        SecretStoreErrorKind::MigrationFailed => AppServerErrorName::SecretStorageMigrationFailed,
    };
    RpcError::new(-32094, name)
}

#[cfg(test)]
#[path = "secret_operations_tests.rs"]
mod tests;
