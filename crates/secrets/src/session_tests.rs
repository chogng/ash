use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use super::SessionSecretStore;
use crate::DeleteSecretOutcome;
use crate::MemorySecretStore;
use crate::SecretKey;
use crate::SecretPersistence;
use crate::SecretStorageMode;
use crate::SecretStore;
use crate::SecretStoreError;
use crate::SecretStoreErrorKind;
use crate::SecretValue;

#[derive(Default)]
struct KeyringBackedStore {
    values: MemorySecretStore,
    failure: Mutex<Option<SecretStoreErrorKind>>,
    mode: Mutex<Option<SecretStorageMode>>,
    calls: AtomicUsize,
}

impl KeyringBackedStore {
    fn check(&self) -> Result<(), SecretStoreError> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        match *self.failure.lock().unwrap() {
            Some(kind) => Err(SecretStoreError::new(kind, "redacted test failure")),
            None => Ok(()),
        }
    }
}

impl SecretStore for KeyringBackedStore {
    fn storage_mode(&self) -> Result<Option<SecretStorageMode>, SecretStoreError> {
        Ok(*self.mode.lock().unwrap())
    }
    fn check_availability(&self) -> Result<(), SecretStoreError> {
        self.check()
    }
    fn load(&self, key: &SecretKey) -> Result<Option<SecretValue>, SecretStoreError> {
        self.check()?;
        self.values.load(key)
    }
    fn store(&self, key: &SecretKey, value: &SecretValue) -> Result<(), SecretStoreError> {
        self.check()?;
        self.values.store(key, value)
    }
    fn delete(&self, key: &SecretKey) -> Result<DeleteSecretOutcome, SecretStoreError> {
        self.check()?;
        self.values.delete(key)
    }
}

#[test]
fn keyring_failure_uses_one_ephemeral_facility_without_repeated_background_access() {
    for kind in [
        SecretStoreErrorKind::AccessDenied,
        SecretStoreErrorKind::BackendUnavailable,
    ] {
        let persisted = Arc::new(KeyringBackedStore::default());
        let old = SecretKey::new("old-account").unwrap();
        let current = SecretKey::new("current-account").unwrap();
        persisted
            .store(&old, &SecretValue::new(b"saved".to_vec()))
            .unwrap();
        *persisted.failure.lock().unwrap() = Some(kind);
        let store = SessionSecretStore::new(persisted.clone());
        let before = persisted.calls.load(Ordering::Relaxed);
        assert!(store.load(&old).unwrap().is_none());
        store
            .store(&current, &SecretValue::new(b"temporary".to_vec()))
            .unwrap();
        store.check_availability().unwrap();
        assert_eq!(
            store.load(&current).unwrap().unwrap().expose(),
            b"temporary"
        );
        assert_eq!(persisted.calls.load(Ordering::Relaxed), before + 1);
        assert_eq!(
            store.persistence().unwrap(),
            SecretPersistence::InMemory { reason: Some(kind) }
        );
        assert!(store.restore_persistence().is_err());
        assert_eq!(
            store.load(&current).unwrap().unwrap().expose(),
            b"temporary"
        );

        *persisted.failure.lock().unwrap() = None;
        // A newly opened profile has none of the preceding process's ephemeral credentials.
        assert!(
            SessionSecretStore::new(persisted.clone())
                .load(&current)
                .unwrap()
                .is_none()
        );
        store.restore_persistence().unwrap();
        assert_eq!(store.persistence().unwrap(), SecretPersistence::Persisted);
        assert_eq!(persisted.load(&old).unwrap().unwrap().expose(), b"saved");
        assert_eq!(
            persisted.load(&current).unwrap().unwrap().expose(),
            b"temporary"
        );
    }
}

#[test]
fn recovery_commits_ephemeral_deletions_before_returning_to_disk() {
    let persisted = Arc::new(KeyringBackedStore::default());
    let key = SecretKey::new("account").unwrap();
    persisted
        .store(&key, &SecretValue::new(b"old".to_vec()))
        .unwrap();
    *persisted.failure.lock().unwrap() = Some(SecretStoreErrorKind::AccessDenied);
    let store = SessionSecretStore::new(persisted.clone());
    store
        .store(&key, &SecretValue::new(b"new".to_vec()))
        .unwrap();
    assert_eq!(store.delete(&key).unwrap(), DeleteSecretOutcome::Deleted);
    *persisted.failure.lock().unwrap() = None;
    store.restore_persistence().unwrap();
    assert!(persisted.load(&key).unwrap().is_none());
}

#[test]
fn an_explicit_file_choice_preserves_permission_failures_without_fallback() {
    let persisted = Arc::new(KeyringBackedStore::default());
    *persisted.mode.lock().unwrap() = Some(SecretStorageMode::File);
    *persisted.failure.lock().unwrap() = Some(SecretStoreErrorKind::AccessDenied);
    let store = SessionSecretStore::new(persisted);
    assert_eq!(
        store.check_availability().unwrap_err().kind(),
        SecretStoreErrorKind::AccessDenied
    );
    assert_eq!(store.persistence().unwrap(), SecretPersistence::Persisted);
}

#[test]
fn corrupt_or_missing_encryption_keys_remain_recoverable_errors() {
    for kind in [
        SecretStoreErrorKind::KeyMissing,
        SecretStoreErrorKind::InvalidData,
        SecretStoreErrorKind::MigrationFailed,
        SecretStoreErrorKind::BackendFailure,
    ] {
        let persisted = Arc::new(KeyringBackedStore::default());
        *persisted.failure.lock().unwrap() = Some(kind);
        let store = SessionSecretStore::new(persisted);
        assert_eq!(
            store
                .load(&SecretKey::new("account").unwrap())
                .unwrap_err()
                .kind(),
            kind
        );
        assert_eq!(store.persistence().unwrap(), SecretPersistence::Persisted);
    }
}
