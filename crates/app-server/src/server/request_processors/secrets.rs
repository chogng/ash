use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::secrets::SecretStorageMode;
use ash_app_server_protocol::protocol::secrets::SecretStorageModeSetParams;
use ash_app_server_protocol::protocol::secrets::SecretStorageStatus;
use ash_app_server_protocol::protocol::secrets::SecretStorageStatusResult;
use ash_app_server_protocol::protocol::secrets::SecretStorageType;
use ash_secrets::SecretPersistence;
use ash_secrets::SecretStoreErrorKind;
use serde_json::Value;

use super::RpcError;
use super::decode;
use super::result;

/// Keeps storage authorization and redacted storage failures at the secrets boundary.
#[derive(Default)]
pub(super) struct SecretRequestProcessor {
    secret_store: Option<std::sync::Arc<dyn ash_secrets::SecretStore>>,
}

impl SecretRequestProcessor {
    pub(super) fn new(store: std::sync::Arc<dyn ash_secrets::SecretStore>) -> Self {
        Self {
            secret_store: Some(store),
        }
    }
    pub(super) fn check_availability(&self) -> Result<(), RpcError> {
        if let Some(store) = &self.secret_store {
            store
                .check_availability()
                .map_err(|error| storage_error(error.kind()))?;
        }
        Ok(())
    }

    pub(super) fn secrets_status(&self, params: &Value) -> Result<Value, RpcError> {
        let _: ash_app_server_protocol::protocol::common::EmptyParams = decode(params)?;
        result(&self.secret_storage_state(SecretAccess::Silent)?)
    }

    pub(super) fn secrets_authorize(
        &self,
        params: &Value,
    ) -> Result<SecretStorageStatusResult, RpcError> {
        let _: ash_app_server_protocol::protocol::common::EmptyParams = decode(params)?;
        self.secret_storage_state(SecretAccess::Authorize)
    }

    pub(super) fn secrets_storage_mode_set(
        &self,
        params: &Value,
    ) -> Result<SecretStorageStatusResult, RpcError> {
        let params: SecretStorageModeSetParams = decode(params)?;
        let store = self
            .secret_store
            .as_ref()
            .ok_or_else(|| storage_error(SecretStoreErrorKind::BackendUnavailable))?;
        let mode = match params.mode {
            SecretStorageMode::Encrypted => ash_secrets::SecretStorageMode::Encrypted,
            SecretStorageMode::File => ash_secrets::SecretStorageMode::File,
        };
        match mode {
            ash_secrets::SecretStorageMode::Encrypted => {
                ash_keyring_store::with_user_authorization(|| store.set_storage_mode(mode))
            }
            ash_secrets::SecretStorageMode::File => store.set_storage_mode(mode),
        }
        .map_err(|error| storage_error(error.kind()))?;
        self.secret_storage_state(SecretAccess::Silent)
    }

    fn secret_storage_state(
        &self,
        access: SecretAccess,
    ) -> Result<SecretStorageStatusResult, RpcError> {
        let status = match &self.secret_store {
            Some(store) => match match access {
                SecretAccess::Silent => store.check_availability(),
                SecretAccess::Authorize => {
                    ash_keyring_store::with_user_authorization(|| store.restore_persistence())
                }
            } {
                Ok(()) => SecretStorageStatus::Available,
                Err(error) => storage_status(error.kind()),
            },
            None => SecretStorageStatus::Unavailable,
        };
        let mode = match &self.secret_store {
            Some(store) => store
                .storage_mode()
                .map_err(|error| storage_error(error.kind()))?
                .map(|mode| match mode {
                    ash_secrets::SecretStorageMode::Encrypted => SecretStorageMode::Encrypted,
                    ash_secrets::SecretStorageMode::File => SecretStorageMode::File,
                }),
            None => None,
        };
        let (status, storage_type) = match &self.secret_store {
            Some(store) => match store
                .persistence()
                .map_err(|error| storage_error(error.kind()))?
            {
                SecretPersistence::Persisted => (status, None),
                SecretPersistence::InMemory { reason } => (
                    // An unsuccessful explicit recovery must keep its actual failure visible.
                    if status == SecretStorageStatus::Available {
                        reason.map(storage_status).unwrap_or(status)
                    } else {
                        status
                    },
                    Some(SecretStorageType::InMemory),
                ),
            },
            None => (status, None),
        };
        Ok(SecretStorageStatusResult {
            status,
            mode,
            storage_type,
        })
    }
}

enum SecretAccess {
    Silent,
    Authorize,
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
#[path = "../secret_operations_tests.rs"]
mod tests;
