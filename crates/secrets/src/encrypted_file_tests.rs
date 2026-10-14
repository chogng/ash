use std::fs;
use std::sync::Arc;

use super::EncryptedFileSecretStore;
use super::MASTER_KEY_NAME;
use super::MAX_SECRET_BYTES;
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
fn encrypted_round_trip_restart_replace_delete_and_private_ciphertext() {
    let root = tempfile::tempdir().unwrap();
    let keyring = Arc::new(MemorySecretStore::default());
    let store = EncryptedFileSecretStore::open(root.path(), keyring.clone()).unwrap();
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
    let store = EncryptedFileSecretStore::open(root.path(), keyring).unwrap();
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
    let store = EncryptedFileSecretStore::open(root.path(), Arc::new(MemorySecretStore::default()))
        .unwrap();
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
    let store = EncryptedFileSecretStore::open(root.path(), Arc::new(MemorySecretStore::default()))
        .unwrap();
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
    let store = EncryptedFileSecretStore::open(root.path(), Arc::new(MemorySecretStore::default()))
        .unwrap();
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
    let store =
        EncryptedFileSecretStore::open(root.path(), Arc::new(UnavailableSecretStore)).unwrap();
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
    let store = EncryptedFileSecretStore::open(root.path(), keyring.clone()).unwrap();
    let name = key("provider/test");
    store
        .store(&name, &SecretValue::new(b"credential".to_vec()))
        .unwrap();
    let before = fs::read(store.files.value_path(&name)).unwrap();
    keyring.delete(&key(MASTER_KEY_NAME)).unwrap();
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
    let store = EncryptedFileSecretStore::open(root.path(), keyring.clone()).unwrap();
    store.check_availability().unwrap();
    keyring
        .store(&key(MASTER_KEY_NAME), &SecretValue::new(vec![7; 32]))
        .unwrap();
    assert_eq!(
        store.check_availability().unwrap_err().kind(),
        SecretStoreErrorKind::InvalidData
    );
    fs::write(store.files.values.join(super::KEY_CHECK), b"bad envelope").unwrap();
    assert_eq!(
        store.check_availability().unwrap_err().kind(),
        SecretStoreErrorKind::InvalidData
    );
}

#[test]
fn tampered_and_swapped_values_cannot_be_read_as_plaintext() {
    let root = tempfile::tempdir().unwrap();
    let store = EncryptedFileSecretStore::open(root.path(), Arc::new(MemorySecretStore::default()))
        .unwrap();
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
    let store = EncryptedFileSecretStore::open(root.path(), Arc::new(MemorySecretStore::default()))
        .unwrap();
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
                let store = EncryptedFileSecretStore::open(path, keyring).unwrap();
                let name = key(&format!("provider/{index}"));
                store.store(&name, &SecretValue::new(vec![index])).unwrap();
            });
        }
    });
    let store = EncryptedFileSecretStore::open(root.path(), keyring).unwrap();
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
    assert!(
        EncryptedFileSecretStore::open(root.path(), Arc::new(MemorySecretStore::default()))
            .is_err()
    );
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
    let store = EncryptedFileSecretStore::open(
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
    let store = EncryptedFileSecretStore::open(
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
