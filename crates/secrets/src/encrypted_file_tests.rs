use std::fs;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use super::MASTER_KEY_NAME;
use super::MAX_SECRET_BYTES;
use super::ProfileSecretStore;
use crate::DeleteSecretOutcome;
use crate::FileSecretStore;
use crate::MemorySecretStore;
use crate::SecretKey;
use crate::SecretStore;
use crate::SecretStoreError;
use crate::SecretStoreErrorKind;
use crate::SecretValue;
use crate::UnavailableSecretStore;

fn key(name: &str) -> SecretKey {
    SecretKey::new(name).unwrap()
}

#[test]
fn profile_purge_only_deletes_its_encryption_key_and_is_retryable() {
    let keyring = MemorySecretStore::default();
    keyring
        .store(&key(MASTER_KEY_NAME), &SecretValue::new(vec![1; 32]))
        .unwrap();
    keyring
        .store(&key("unrelated/entry"), &SecretValue::new(vec![2]))
        .unwrap();
    assert_eq!(
        ProfileSecretStore::delete_encryption_key(&keyring).unwrap(),
        DeleteSecretOutcome::Deleted
    );
    assert_eq!(
        ProfileSecretStore::delete_encryption_key(&keyring).unwrap(),
        DeleteSecretOutcome::NotFound
    );
    assert_eq!(
        keyring
            .load(&key("unrelated/entry"))
            .unwrap()
            .unwrap()
            .expose(),
        &[2]
    );
}

#[derive(Clone, Copy, Default)]
enum KeyringState {
    #[default]
    Available,
    LoadFailure(SecretStoreErrorKind),
    StoreFailure(SecretStoreErrorKind),
}

/// Counts OS-boundary calls without accessing the developer's system keyring.
#[derive(Default)]
struct CountingKeyring {
    values: MemorySecretStore,
    loads: AtomicUsize,
    stores: AtomicUsize,
    state: Mutex<KeyringState>,
}

impl SecretStore for CountingKeyring {
    fn load(&self, key: &SecretKey) -> Result<Option<SecretValue>, SecretStoreError> {
        self.loads.fetch_add(1, Ordering::SeqCst);
        match *self.state.lock().unwrap() {
            KeyringState::LoadFailure(kind) => {
                Err(SecretStoreError::new(kind, "fake keyring read failed"))
            }
            KeyringState::Available | KeyringState::StoreFailure(_) => self.values.load(key),
        }
    }

    fn store(&self, key: &SecretKey, value: &SecretValue) -> Result<(), SecretStoreError> {
        self.stores.fetch_add(1, Ordering::SeqCst);
        match *self.state.lock().unwrap() {
            KeyringState::StoreFailure(kind) => {
                Err(SecretStoreError::new(kind, "fake keyring write failed"))
            }
            KeyringState::Available | KeyringState::LoadFailure(_) => self.values.store(key, value),
        }
    }

    fn delete(&self, key: &SecretKey) -> Result<DeleteSecretOutcome, SecretStoreError> {
        self.values.delete(key)
    }
}

#[test]
fn file_default_persists_without_keyring_access_and_preserves_explicit_mode() {
    let root = tempfile::tempdir().unwrap();
    let keyring = Arc::new(CountingKeyring::default());
    let name = key("development/api-key");
    let store = ProfileSecretStore::open_with_default_mode(
        root.path(),
        keyring.clone(),
        crate::SecretStorageMode::File,
    )
    .unwrap();
    store.check_availability().unwrap();
    store
        .store(&name, &SecretValue::new(b"development credential".to_vec()))
        .unwrap();
    drop(store);
    let reopened = ProfileSecretStore::open(root.path(), keyring.clone()).unwrap();
    assert_eq!(
        reopened.storage_mode().unwrap(),
        Some(crate::SecretStorageMode::File)
    );
    assert_eq!(
        reopened.load(&name).unwrap().unwrap().expose(),
        b"development credential"
    );
    assert_eq!(keyring.loads.load(Ordering::SeqCst), 0);
    assert_eq!(keyring.stores.load(Ordering::SeqCst), 0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(root.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&reopened.legacy.values)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(reopened.legacy.value_path(&name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    reopened
        .set_storage_mode(crate::SecretStorageMode::Encrypted)
        .unwrap();
    drop(reopened);
    let encrypted = ProfileSecretStore::open_with_default_mode(
        root.path(),
        keyring,
        crate::SecretStorageMode::File,
    )
    .unwrap();
    assert_eq!(
        encrypted.storage_mode().unwrap(),
        Some(crate::SecretStorageMode::Encrypted)
    );
    assert_eq!(
        encrypted.load(&name).unwrap().unwrap().expose(),
        b"development credential"
    );
}

#[test]
fn file_default_never_reinterprets_existing_ciphertext() {
    let root = tempfile::tempdir().unwrap();
    let name = key("existing/api-key");
    let keyring = Arc::new(MemorySecretStore::default());
    let store = ProfileSecretStore::open(root.path(), keyring).unwrap();
    store
        .store(&name, &SecretValue::new(b"existing credential".to_vec()))
        .unwrap();
    let path = store.files.value_path(&name);
    let ciphertext = fs::read(&path).unwrap();
    drop(store);
    let reopened = ProfileSecretStore::open_with_default_mode(
        root.path(),
        Arc::new(UnavailableSecretStore),
        crate::SecretStorageMode::File,
    )
    .unwrap();
    assert_eq!(
        reopened.storage_mode().unwrap(),
        Some(crate::SecretStorageMode::Encrypted)
    );
    assert!(reopened.load(&name).is_err());
    assert_eq!(fs::read(path).unwrap(), ciphertext);
    assert!(!root.path().join(super::STORAGE_MODE).exists());
}

#[test]
fn empty_reads_and_deletes_do_not_allocate_a_persistent_master_key() {
    let root = tempfile::tempdir().unwrap();
    let keyring = Arc::new(CountingKeyring::default());
    let name = key("provider/absent");
    for _ in 0..2 {
        let store = ProfileSecretStore::open(root.path(), keyring.clone()).unwrap();
        assert!(store.load(&name).unwrap().is_none());
        assert_eq!(store.delete(&name).unwrap(), DeleteSecretOutcome::NotFound);
        assert_eq!(fs::read_dir(&store.files.values).unwrap().count(), 0);
    }
    assert_eq!(keyring.loads.load(Ordering::SeqCst), 0);
    assert_eq!(keyring.stores.load(Ordering::SeqCst), 0);

    // An explicit availability request still verifies that a new key can be persisted.
    let store = ProfileSecretStore::open(root.path(), keyring.clone()).unwrap();
    store.check_availability().unwrap();
    assert_eq!(keyring.loads.load(Ordering::SeqCst), 1);
    assert_eq!(keyring.stores.load(Ordering::SeqCst), 1);
    drop(store);
    keyring.delete(&key(MASTER_KEY_NAME)).unwrap();
    let reopened = ProfileSecretStore::open(root.path(), keyring).unwrap();
    assert_eq!(
        reopened.load(&name).unwrap_err().kind(),
        SecretStoreErrorKind::KeyMissing
    );
    assert_eq!(
        reopened.delete(&name).unwrap_err().kind(),
        SecretStoreErrorKind::KeyMissing
    );
}

#[test]
fn queued_secret_operations_and_status_queries_acquire_the_master_key_once() {
    let root = tempfile::tempdir().unwrap();
    let keyring = Arc::new(CountingKeyring::default());
    let store = ProfileSecretStore::open(root.path(), keyring.clone()).unwrap();
    assert_eq!(keyring.loads.load(Ordering::SeqCst), 0);
    assert_eq!(keyring.stores.load(Ordering::SeqCst), 0);

    std::thread::scope(|scope| {
        for index in 0..12 {
            let store = &store;
            scope.spawn(move || {
                let name = key(&format!("provider/{index}"));
                store.store(&name, &SecretValue::new(vec![index])).unwrap();
                assert_eq!(store.load(&name).unwrap().unwrap().expose(), &[index]);
                store.check_availability().unwrap();
                assert_eq!(store.delete(&name).unwrap(), DeleteSecretOutcome::Deleted);
            });
        }
    });
    assert_eq!(keyring.loads.load(Ordering::SeqCst), 1);
    assert_eq!(keyring.stores.load(Ordering::SeqCst), 1);

    // A new profile runtime reacquires the existing OS key, rather than sharing a global cache.
    drop(store);
    let reopened = ProfileSecretStore::open(root.path(), keyring.clone()).unwrap();
    reopened.check_availability().unwrap();
    reopened.check_availability().unwrap();
    assert_eq!(keyring.loads.load(Ordering::SeqCst), 2);
    assert_eq!(keyring.stores.load(Ordering::SeqCst), 1);
}

#[test]
fn failed_keyring_access_preserves_values_and_allows_same_runtime_authorization_retry() {
    for kind in [
        SecretStoreErrorKind::AccessDenied,
        SecretStoreErrorKind::BackendUnavailable,
        SecretStoreErrorKind::BackendFailure,
    ] {
        for state in [
            KeyringState::LoadFailure(kind),
            KeyringState::StoreFailure(kind),
        ] {
            let root = tempfile::tempdir().unwrap();
            let keyring = Arc::new(CountingKeyring::default());
            *keyring.state.lock().unwrap() = state;
            let name = key("provider/test");
            let legacy = FileSecretStore::open(root.path()).unwrap();
            legacy
                .store(&name, &SecretValue::new(b"old".to_vec()))
                .unwrap();
            let store = ProfileSecretStore::open(root.path(), keyring.clone()).unwrap();
            let error = store.check_availability().unwrap_err();
            assert_eq!(error.kind(), kind);

            for _ in 0..4 {
                assert_eq!(store.check_availability().unwrap_err(), error);
                assert_eq!(store.load(&name).unwrap_err(), error);
                assert_eq!(
                    store
                        .store(&name, &SecretValue::new(b"new".to_vec()))
                        .unwrap_err(),
                    error
                );
                assert_eq!(store.delete(&name).unwrap_err(), error);
            }
            assert_eq!(keyring.loads.load(Ordering::SeqCst), 17);
            let expected_stores = match state {
                KeyringState::LoadFailure(_) => 0,
                KeyringState::StoreFailure(_) => 17,
                KeyringState::Available => unreachable!("failure fixture"),
            };
            assert_eq!(keyring.stores.load(Ordering::SeqCst), expected_stores);
            assert_eq!(legacy.load(&name).unwrap().unwrap().expose(), b"old");
            assert_eq!(fs::read_dir(&store.files.values).unwrap().count(), 0);

            // The platform adapter keeps ordinary requests silent. Once an explicit user
            // authorization repairs access, this same runtime must be able to acquire its key.
            *keyring.state.lock().unwrap() = KeyringState::Available;
            assert_eq!(store.load(&name).unwrap().unwrap().expose(), b"old");
            store.check_availability().unwrap();
            assert_eq!(store.load(&name).unwrap().unwrap().expose(), b"old");
            assert_eq!(keyring.loads.load(Ordering::SeqCst), 18);
            assert_eq!(keyring.stores.load(Ordering::SeqCst), expected_stores + 1);
        }
    }
}

#[test]
fn encrypted_round_trip_restart_replace_delete_and_private_ciphertext() {
    let root = tempfile::tempdir().unwrap();
    let keyring = Arc::new(MemorySecretStore::default());
    let store = ProfileSecretStore::open(root.path(), keyring.clone()).unwrap();
    let name = key("provider/test/api-key");
    let value = b"sensitive-credential-unique\0\xff";
    store
        .store(&name, &SecretValue::new(value.to_vec()))
        .unwrap();
    let path = store.files.value_path(&name);
    let first = fs::read(&path).unwrap();
    assert!(!first.windows(value.len()).any(|bytes| bytes == value));
    assert_eq!(fs::read_dir(root.path().join("values")).unwrap().count(), 0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    drop(store);
    let store = ProfileSecretStore::open(root.path(), keyring).unwrap();
    assert_eq!(store.load(&name).unwrap().unwrap().expose(), value);
    store
        .store(&name, &SecretValue::new(value.to_vec()))
        .unwrap();
    assert_ne!(
        first,
        fs::read(&path).unwrap(),
        "each write uses a fresh nonce"
    );
    store
        .store(&name, &SecretValue::new(b"replacement".to_vec()))
        .unwrap();
    assert_eq!(store.load(&name).unwrap().unwrap().expose(), b"replacement");
    assert_eq!(store.delete(&name).unwrap(), DeleteSecretOutcome::Deleted);
    assert_eq!(store.delete(&name).unwrap(), DeleteSecretOutcome::NotFound);
    assert!(store.load(&name).unwrap().is_none());
}

#[test]
fn existing_plaintext_is_migrated_before_any_secret_operation() {
    let root = tempfile::tempdir().unwrap();
    let legacy = FileSecretStore::open(root.path()).unwrap();
    let names = [key("provider/openai/api-key"), key("mcp/server/oauth")];
    for name in &names {
        legacy
            .store(name, &SecretValue::new(b"old-credential".to_vec()))
            .unwrap();
    }
    let store =
        ProfileSecretStore::open(root.path(), Arc::new(MemorySecretStore::default())).unwrap();
    store.check_availability().unwrap();
    assert_eq!(fs::read_dir(root.path().join("values")).unwrap().count(), 0);
    for name in &names {
        assert_eq!(
            store.load(name).unwrap().unwrap().expose(),
            b"old-credential"
        );
    }
}

#[test]
fn interrupted_migration_resumes_after_a_verified_ciphertext_commit() {
    let root = tempfile::tempdir().unwrap();
    let store =
        ProfileSecretStore::open(root.path(), Arc::new(MemorySecretStore::default())).unwrap();
    let name = key("connector/oauth");
    store
        .store(&name, &SecretValue::new(b"credential".to_vec()))
        .unwrap();
    // Crash after committing ciphertext and before unlinking its legacy counterpart.
    store
        .legacy
        .store(&name, &SecretValue::new(b"credential".to_vec()))
        .unwrap();
    store.check_availability().unwrap();
    assert!(store.legacy.load(&name).unwrap().is_none());
    assert_eq!(store.load(&name).unwrap().unwrap().expose(), b"credential");
}

#[test]
fn conflicting_migration_preserves_both_values() {
    let root = tempfile::tempdir().unwrap();
    let store =
        ProfileSecretStore::open(root.path(), Arc::new(MemorySecretStore::default())).unwrap();
    let name = key("provider/test");
    store
        .store(&name, &SecretValue::new(b"new".to_vec()))
        .unwrap();
    store
        .legacy
        .store(&name, &SecretValue::new(b"old".to_vec()))
        .unwrap();
    let before = fs::read(store.files.value_path(&name)).unwrap();
    assert_eq!(
        store.check_availability().unwrap_err().kind(),
        SecretStoreErrorKind::MigrationFailed
    );
    assert_eq!(store.legacy.load(&name).unwrap().unwrap().expose(), b"old");
    assert_eq!(fs::read(store.files.value_path(&name)).unwrap(), before);
}

#[test]
fn unavailable_keyring_does_not_write_plaintext_or_remove_legacy_values() {
    let root = tempfile::tempdir().unwrap();
    let legacy = FileSecretStore::open(root.path()).unwrap();
    let name = key("provider/test");
    legacy
        .store(&name, &SecretValue::new(b"old".to_vec()))
        .unwrap();
    let store = ProfileSecretStore::open(root.path(), Arc::new(UnavailableSecretStore)).unwrap();
    assert_eq!(
        store.check_availability().unwrap_err().kind(),
        SecretStoreErrorKind::BackendUnavailable
    );
    assert_eq!(
        store
            .store(&name, &SecretValue::new(b"new".to_vec()))
            .unwrap_err()
            .kind(),
        SecretStoreErrorKind::BackendUnavailable
    );
    assert_eq!(legacy.load(&name).unwrap().unwrap().expose(), b"old");
    assert_eq!(fs::read_dir(store.files.values).unwrap().count(), 0);
}

#[test]
fn missing_master_key_does_not_regenerate_or_overwrite_ciphertext() {
    let root = tempfile::tempdir().unwrap();
    let keyring = Arc::new(MemorySecretStore::default());
    let store = ProfileSecretStore::open(root.path(), keyring.clone()).unwrap();
    let name = key("provider/test");
    store
        .store(&name, &SecretValue::new(b"credential".to_vec()))
        .unwrap();
    let before = fs::read(store.files.value_path(&name)).unwrap();
    keyring.delete(&key(MASTER_KEY_NAME)).unwrap();
    // An active runtime keeps its unlocked key; a new runtime must observe its removal.
    assert_eq!(store.load(&name).unwrap().unwrap().expose(), b"credential");
    drop(store);
    let store = ProfileSecretStore::open(root.path(), keyring.clone()).unwrap();
    assert_eq!(
        store.check_availability().unwrap_err().kind(),
        SecretStoreErrorKind::KeyMissing
    );
    assert_eq!(
        store
            .store(&name, &SecretValue::new(b"new".to_vec()))
            .unwrap_err()
            .kind(),
        SecretStoreErrorKind::KeyMissing
    );
    assert!(keyring.load(&key(MASTER_KEY_NAME)).unwrap().is_none());
    assert_eq!(fs::read(store.files.value_path(&name)).unwrap(), before);
}

#[test]
fn wrong_master_key_and_corrupted_witness_fail_closed() {
    let root = tempfile::tempdir().unwrap();
    let keyring = Arc::new(MemorySecretStore::default());
    let store = ProfileSecretStore::open(root.path(), keyring.clone()).unwrap();
    store.check_availability().unwrap();
    let original = keyring.load(&key(MASTER_KEY_NAME)).unwrap().unwrap();
    keyring
        .store(&key(MASTER_KEY_NAME), &SecretValue::new(vec![7; 32]))
        .unwrap();
    drop(store);
    let store = ProfileSecretStore::open(root.path(), keyring.clone()).unwrap();
    assert_eq!(
        store.check_availability().unwrap_err().kind(),
        SecretStoreErrorKind::InvalidData
    );
    keyring.store(&key(MASTER_KEY_NAME), &original).unwrap();
    store.check_availability().unwrap();
    fs::write(store.files.values.join(super::KEY_CHECK), b"bad envelope").unwrap();
    assert_eq!(
        store.check_availability().unwrap_err().kind(),
        SecretStoreErrorKind::InvalidData
    );
}

#[test]
fn tampered_and_swapped_values_cannot_be_read_as_plaintext() {
    let root = tempfile::tempdir().unwrap();
    let store =
        ProfileSecretStore::open(root.path(), Arc::new(MemorySecretStore::default())).unwrap();
    let first = key("provider/first");
    let second = key("provider/second");
    store
        .store(&first, &SecretValue::new(b"first-secret".to_vec()))
        .unwrap();
    store
        .store(&second, &SecretValue::new(b"second-secret".to_vec()))
        .unwrap();
    let ciphertext = fs::read(store.files.value_path(&first)).unwrap();
    fs::write(store.files.value_path(&second), &ciphertext).unwrap();
    assert_eq!(
        store.check_availability().unwrap_err().kind(),
        SecretStoreErrorKind::InvalidData
    );
    assert_eq!(
        store.load(&second).unwrap_err().kind(),
        SecretStoreErrorKind::InvalidData
    );
    let mut tampered = ciphertext;
    *tampered.last_mut().unwrap() ^= 1;
    fs::write(store.files.value_path(&first), &tampered).unwrap();
    let error = store.load(&first).unwrap_err();
    assert_eq!(error.kind(), SecretStoreErrorKind::InvalidData);
    assert!(!format!("{error:?}").contains("first-secret"));
}

#[test]
fn full_plaintext_size_limit_survives_envelope_overhead() {
    let root = tempfile::tempdir().unwrap();
    let store =
        ProfileSecretStore::open(root.path(), Arc::new(MemorySecretStore::default())).unwrap();
    let name = key("provider/large");
    let value = SecretValue::new(vec![42; MAX_SECRET_BYTES as usize]);
    store.store(&name, &value).unwrap();
    assert_eq!(store.load(&name).unwrap().unwrap().expose(), value.expose());
    assert!(
        store
            .store(
                &name,
                &SecretValue::new(vec![42; MAX_SECRET_BYTES as usize + 1])
            )
            .is_err()
    );
}

#[test]
fn concurrent_store_instances_share_one_key_and_preserve_each_value() {
    let root = tempfile::tempdir().unwrap();
    let keyring = Arc::new(MemorySecretStore::default());
    std::thread::scope(|scope| {
        for index in 0..12 {
            let keyring = keyring.clone();
            let path = root.path();
            scope.spawn(move || {
                let store = ProfileSecretStore::open(path, keyring).unwrap();
                let name = key(&format!("provider/{index}"));
                store.store(&name, &SecretValue::new(vec![index])).unwrap();
            });
        }
    });
    let store = ProfileSecretStore::open(root.path(), keyring).unwrap();
    for index in 0..12 {
        assert_eq!(
            store
                .load(&key(&format!("provider/{index}")))
                .unwrap()
                .unwrap()
                .expose(),
            &[index]
        );
    }
}

#[cfg(unix)]
#[test]
fn encrypted_store_rejects_symlinked_ciphertext_directory() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), root.path().join("encrypted")).unwrap();
    assert!(ProfileSecretStore::open(root.path(), Arc::new(MemorySecretStore::default())).is_err());
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}

// A file-backed fake system facility lets independent test processes share a master key without
// touching the developer's keyring. Its operations run only under the encrypted store's lock.
struct ProcessKeyring(std::path::PathBuf);

impl SecretStore for ProcessKeyring {
    fn load(&self, _: &SecretKey) -> Result<Option<SecretValue>, SecretStoreError> {
        match fs::read(&self.0) {
            Ok(bytes) => Ok(Some(SecretValue::new(bytes))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(SecretStoreError::new(
                SecretStoreErrorKind::BackendFailure,
                "fake keyring read failed",
            )),
        }
    }

    fn store(&self, _: &SecretKey, value: &SecretValue) -> Result<(), SecretStoreError> {
        fs::write(&self.0, value.expose()).map_err(|_| {
            SecretStoreError::new(
                SecretStoreErrorKind::BackendFailure,
                "fake keyring write failed",
            )
        })
    }

    fn delete(&self, _: &SecretKey) -> Result<DeleteSecretOutcome, SecretStoreError> {
        fs::remove_file(&self.0)
            .map(|_| DeleteSecretOutcome::Deleted)
            .map_err(|_| {
                SecretStoreError::new(
                    SecretStoreErrorKind::BackendFailure,
                    "fake keyring delete failed",
                )
            })
    }
}

#[test]
fn encrypted_process_worker() {
    let Some(root) = std::env::var_os("ASH_SECRET_STORE_PROCESS_TEST_ROOT") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    let index = std::env::var("ASH_SECRET_STORE_PROCESS_TEST_INDEX")
        .unwrap()
        .parse::<u8>()
        .unwrap();
    let store = ProfileSecretStore::open(
        root.join("profile"),
        Arc::new(ProcessKeyring(root.join("fake-system-keyring"))),
    )
    .unwrap();
    store
        .store(
            &key(&format!("provider/{index}")),
            &SecretValue::new(vec![index]),
        )
        .unwrap();
}

#[test]
fn independent_processes_initialize_one_key_and_read_each_others_ciphertext() {
    let root = tempfile::tempdir().unwrap();
    let mut children = Vec::new();
    for index in 0..4 {
        children.push(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "file::encrypted::tests::encrypted_process_worker",
                ])
                .env("ASH_SECRET_STORE_PROCESS_TEST_ROOT", root.path())
                .env("ASH_SECRET_STORE_PROCESS_TEST_INDEX", index.to_string())
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
    }
    for mut child in children {
        assert!(child.wait().unwrap().success());
    }
    let store = ProfileSecretStore::open(
        root.path().join("profile"),
        Arc::new(ProcessKeyring(root.path().join("fake-system-keyring"))),
    )
    .unwrap();
    store.check_availability().unwrap();
    for index in 0..4 {
        assert_eq!(
            store
                .load(&key(&format!("provider/{index}")))
                .unwrap()
                .unwrap()
                .expose(),
            &[index]
        );
    }
}

#[test]
fn explicit_file_mode_survives_restart_and_never_accesses_unavailable_keyring() {
    let root = tempfile::tempdir().unwrap();
    let store = ProfileSecretStore::open(root.path(), Arc::new(UnavailableSecretStore)).unwrap();
    assert!(store.check_availability().is_err());
    store
        .set_storage_mode(crate::SecretStorageMode::File)
        .unwrap();
    let name = key("provider/file-mode");
    store
        .store(&name, &SecretValue::new(b"private-file-value".to_vec()))
        .unwrap();
    let reopened = ProfileSecretStore::open(root.path(), Arc::new(UnavailableSecretStore)).unwrap();
    assert_eq!(
        reopened.storage_mode().unwrap(),
        Some(crate::SecretStorageMode::File)
    );
    reopened.check_availability().unwrap();
    assert_eq!(
        reopened.load(&name).unwrap().unwrap().expose(),
        b"private-file-value"
    );
    assert_eq!(
        reopened.delete(&name).unwrap(),
        DeleteSecretOutcome::Deleted
    );
}

#[test]
fn explicit_mode_changes_migrate_values_and_are_visible_to_other_profile_handles() {
    let root = tempfile::tempdir().unwrap();
    let keyring = Arc::new(MemorySecretStore::default());
    let first = ProfileSecretStore::open(root.path(), keyring.clone()).unwrap();
    let second = ProfileSecretStore::open(root.path(), keyring).unwrap();
    let name = key("provider/migrated");
    first
        .store(&name, &SecretValue::new(b"first-value".to_vec()))
        .unwrap();
    first
        .set_storage_mode(crate::SecretStorageMode::File)
        .unwrap();
    assert_eq!(fs::read_dir(&first.files.values).unwrap().count(), 0);
    assert_eq!(
        second.load(&name).unwrap().unwrap().expose(),
        b"first-value"
    );
    second
        .store(&name, &SecretValue::new(b"changed-in-file-mode".to_vec()))
        .unwrap();
    second
        .set_storage_mode(crate::SecretStorageMode::Encrypted)
        .unwrap();
    assert_eq!(fs::read_dir(&second.legacy.values).unwrap().count(), 0);
    assert_eq!(
        first.load(&name).unwrap().unwrap().expose(),
        b"changed-in-file-mode"
    );
}

#[test]
fn missing_original_key_refuses_file_switch_and_preserves_ciphertext() {
    let root = tempfile::tempdir().unwrap();
    let keyring = Arc::new(MemorySecretStore::default());
    let store = ProfileSecretStore::open(root.path(), keyring.clone()).unwrap();
    let name = key("provider/preserved");
    store
        .store(&name, &SecretValue::new(b"existing-credential".to_vec()))
        .unwrap();
    let ciphertext = fs::read(store.files.value_path(&name)).unwrap();
    keyring.delete(&key(MASTER_KEY_NAME)).unwrap();
    drop(store);
    let store = ProfileSecretStore::open(root.path(), keyring).unwrap();
    assert_eq!(
        store
            .set_storage_mode(crate::SecretStorageMode::File)
            .unwrap_err()
            .kind(),
        SecretStoreErrorKind::KeyMissing
    );
    assert_eq!(
        store.storage_mode().unwrap(),
        Some(crate::SecretStorageMode::Encrypted)
    );
    assert_eq!(fs::read(store.files.value_path(&name)).unwrap(), ciphertext);
    assert!(store.legacy.load(&name).unwrap().is_none());
}

#[test]
fn interrupted_file_migration_resumes_without_reencrypting_its_destination() {
    let root = tempfile::tempdir().unwrap();
    let keyring = Arc::new(MemorySecretStore::default());
    let store = ProfileSecretStore::open(root.path(), keyring.clone()).unwrap();
    let name = key("provider/interrupted");
    store
        .store(
            &name,
            &SecretValue::new(b"persisted-before-interruption".to_vec()),
        )
        .unwrap();
    store
        .write_storage_state(super::StorageState::Migrating(
            crate::SecretStorageMode::File,
        ))
        .unwrap();
    store
        .legacy
        .store(
            &name,
            &SecretValue::new(b"persisted-before-interruption".to_vec()),
        )
        .unwrap();
    let reopened = ProfileSecretStore::open(root.path(), keyring).unwrap();
    assert_eq!(
        reopened.load(&name).unwrap().unwrap().expose(),
        b"persisted-before-interruption"
    );
    assert_eq!(fs::read_dir(&reopened.files.values).unwrap().count(), 0);
    assert_eq!(
        fs::read(root.path().join(super::STORAGE_MODE)).unwrap(),
        b"file"
    );
}

#[test]
fn interrupted_mode_migration_keeps_conflicting_values_for_recovery() {
    let root = tempfile::tempdir().unwrap();
    let store =
        ProfileSecretStore::open(root.path(), Arc::new(MemorySecretStore::default())).unwrap();
    let name = key("provider/conflict");
    store
        .store(&name, &SecretValue::new(b"original-value".to_vec()))
        .unwrap();
    store
        .write_storage_state(super::StorageState::Migrating(
            crate::SecretStorageMode::File,
        ))
        .unwrap();
    store
        .legacy
        .store(&name, &SecretValue::new(b"conflicting-value".to_vec()))
        .unwrap();
    assert_eq!(
        store.check_availability().unwrap_err().kind(),
        SecretStoreErrorKind::MigrationFailed
    );
    assert!(store.files.value_path(&name).is_file());
    assert_eq!(
        store.legacy.load(&name).unwrap().unwrap().expose(),
        b"conflicting-value"
    );
    assert_eq!(
        fs::read(root.path().join(super::STORAGE_MODE)).unwrap(),
        b"to-file"
    );
}
