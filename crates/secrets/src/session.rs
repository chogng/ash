use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::Mutex;

use crate::DeleteSecretOutcome;
use crate::MemorySecretStore;
use crate::SecretKey;
use crate::SecretPersistence;
use crate::SecretStorageMode;
use crate::SecretStore;
use crate::SecretStoreError;
use crate::SecretStoreErrorKind;
use crate::SecretValue;

enum ActiveStorage {
    Persisted,
    InMemory {
        reason: SecretStoreErrorKind,
        changed: BTreeSet<SecretKey>,
    },
}

/// One profile's active credential facility, with a process-local fallback for a locked keyring.
///
/// Background access never requests authorization. Once unavailable, durable storage is left
/// untouched until explicit recovery; every provider uses the same memory store in the meantime.
/// Missing keys, corrupt ciphertext and incomplete migrations remain errors, preserving evidence
/// needed for recovery. Successful recovery commits this run's changes before resuming disk reads.
pub struct SessionSecretStore {
    persisted: Arc<dyn SecretStore>,
    memory: MemorySecretStore,
    active: Mutex<ActiveStorage>,
}

impl SessionSecretStore {
    pub fn new(persisted: Arc<dyn SecretStore>) -> Self {
        Self {
            persisted,
            memory: MemorySecretStore::default(),
            active: Mutex::new(ActiveStorage::Persisted),
        }
    }

    fn access<T>(
        &self,
        changed_key: Option<&SecretKey>,
        operation: impl Fn(&dyn SecretStore) -> Result<T, SecretStoreError>,
    ) -> Result<T, SecretStoreError> {
        let mut active = self.active.lock().map_err(lock_error)?;
        if matches!(*active, ActiveStorage::Persisted) {
            match operation(self.persisted.as_ref()) {
                Ok(value) => return Ok(value),
                Err(error) => match error.kind() {
                    SecretStoreErrorKind::BackendUnavailable
                    | SecretStoreErrorKind::AccessDenied => {
                        // An explicit private-file choice is independent of the keyring.
                        // Preserve file permission/configuration failures as errors.
                        match self.persisted.storage_mode() {
                            Ok(Some(SecretStorageMode::File)) | Err(_) => return Err(error),
                            Ok(None | Some(SecretStorageMode::Encrypted)) => {}
                        }
                        *active = ActiveStorage::InMemory {
                            reason: error.kind(),
                            changed: BTreeSet::new(),
                        };
                    }
                    SecretStoreErrorKind::BackendFailure
                    | SecretStoreErrorKind::KeyMissing
                    | SecretStoreErrorKind::InvalidData
                    | SecretStoreErrorKind::MigrationFailed => return Err(error),
                },
            }
        }
        let value = operation(&self.memory)?;
        if let ActiveStorage::InMemory { changed, .. } = &mut *active
            && let Some(key) = changed_key
        {
            changed.insert(key.clone());
        }
        Ok(value)
    }

    // Hold the profile's selection lock throughout recovery: no provider can write to
    // memory after its value has been copied. Failed partial copies are safe to retry.
    fn restore(&self, active: &mut ActiveStorage) -> Result<(), SecretStoreError> {
        self.persisted.restore_persistence()?;
        if let ActiveStorage::InMemory { changed, .. } = active {
            for key in changed.iter() {
                match self.memory.load(key)? {
                    Some(value) => self.persisted.store(key, &value)?,
                    None => {
                        self.persisted.delete(key)?;
                    }
                }
            }
            for key in changed.iter() {
                self.memory.delete(key)?;
            }
        }
        *active = ActiveStorage::Persisted;
        Ok(())
    }
}

impl SecretStore for SessionSecretStore {
    fn persistence(&self) -> Result<SecretPersistence, SecretStoreError> {
        Ok(match &*self.active.lock().map_err(lock_error)? {
            ActiveStorage::Persisted => SecretPersistence::Persisted,
            ActiveStorage::InMemory { reason, .. } => SecretPersistence::InMemory {
                reason: Some(*reason),
            },
        })
    }

    fn restore_persistence(&self) -> Result<(), SecretStoreError> {
        let mut active = self.active.lock().map_err(lock_error)?;
        self.restore(&mut active)
    }

    fn storage_mode(&self) -> Result<Option<SecretStorageMode>, SecretStoreError> {
        self.persisted.storage_mode()
    }

    fn set_storage_mode(&self, mode: SecretStorageMode) -> Result<(), SecretStoreError> {
        let mut active = self.active.lock().map_err(lock_error)?;
        self.persisted.set_storage_mode(mode)?;
        self.restore(&mut active)
    }

    fn check_availability(&self) -> Result<(), SecretStoreError> {
        self.access(None, |store| store.check_availability())
    }

    fn load(&self, key: &SecretKey) -> Result<Option<SecretValue>, SecretStoreError> {
        self.access(None, |store| store.load(key))
    }

    fn store(&self, key: &SecretKey, value: &SecretValue) -> Result<(), SecretStoreError> {
        self.access(Some(key), |store| store.store(key, value))
    }

    fn delete(&self, key: &SecretKey) -> Result<DeleteSecretOutcome, SecretStoreError> {
        self.access(Some(key), |store| store.delete(key))
    }
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> SecretStoreError {
    SecretStoreError::new(
        SecretStoreErrorKind::BackendFailure,
        "credential facility lock poisoned",
    )
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
