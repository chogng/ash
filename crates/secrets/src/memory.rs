use std::collections::HashMap;
use std::sync::Mutex;

use zeroize::Zeroize;

use crate::DeleteSecretOutcome;
use crate::SecretKey;
use crate::SecretStore;
use crate::SecretStoreError;
use crate::SecretStoreErrorKind;
use crate::SecretValue;

/// Process-local secret storage for tests, CI, and explicitly ephemeral hosts.
///
/// Values disappear when the store is dropped and are never persisted.
#[derive(Default)]
pub struct MemorySecretStore {
    values: Mutex<HashMap<SecretKey, Vec<u8>>>,
}

impl SecretStore for MemorySecretStore {
    fn load(&self, key: &SecretKey) -> Result<Option<SecretValue>, SecretStoreError> {
        let values = self.values.lock().map_err(lock_error)?;
        Ok(values.get(key).cloned().map(SecretValue::new))
    }

    fn store(&self, key: &SecretKey, value: &SecretValue) -> Result<(), SecretStoreError> {
        let mut values = self.values.lock().map_err(lock_error)?;
        if let Some(mut replaced) = values.insert(key.clone(), value.expose().to_vec()) {
            replaced.zeroize();
        }
        Ok(())
    }

    fn delete(&self, key: &SecretKey) -> Result<DeleteSecretOutcome, SecretStoreError> {
        let mut values = self.values.lock().map_err(lock_error)?;
        match values.remove(key) {
            Some(mut removed) => {
                removed.zeroize();
                Ok(DeleteSecretOutcome::Deleted)
            }
            None => Ok(DeleteSecretOutcome::NotFound),
        }
    }
}

impl Drop for MemorySecretStore {
    fn drop(&mut self) {
        if let Ok(values) = self.values.get_mut() {
            for value in values.values_mut() {
                value.zeroize();
            }
        }
    }
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> SecretStoreError {
    SecretStoreError::new(
        SecretStoreErrorKind::BackendFailure,
        "in-memory secret store lock poisoned",
    )
}
