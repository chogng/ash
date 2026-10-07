use std::fs;

use tempfile::tempdir;

use super::*;

#[test]
fn durable_store_round_trips_replaces_and_recovers() {
    let root = tempdir().unwrap();
    let key = SecretKey::new("connector/acme/account").unwrap();
    {
        let store = FileSecretStore::open(root.path()).unwrap();
        store
            .store(&key, &SecretValue::new(b"first".to_vec()))
            .unwrap();
        store
            .store(&key, &SecretValue::new(b"replacement".to_vec()))
            .unwrap();
    }

    let recovered = FileSecretStore::open(root.path()).unwrap();
    assert_eq!(
        recovered.load(&key).unwrap().unwrap().expose(),
        b"replacement"
    );
    assert_eq!(
        recovered.delete(&key).unwrap(),
        DeleteSecretOutcome::Deleted
    );
    assert_eq!(
        recovered.delete(&key).unwrap(),
        DeleteSecretOutcome::NotFound
    );
}

#[test]
fn durable_store_hides_keys_and_cleans_crash_staging() {
    let root = tempdir().unwrap();
    let key = SecretKey::new("provider/name/account@example.com").unwrap();
    let store = FileSecretStore::open(root.path()).unwrap();
    store
        .store(&key, &SecretValue::new(b"secret".to_vec()))
        .unwrap();
    fs::write(root.path().join("values/.tmp-abandoned"), b"partial").unwrap();
    drop(store);

    FileSecretStore::open(root.path()).unwrap();
    let names = fs::read_dir(root.path().join("values"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();

    assert_eq!(names.len(), 1);
    assert!(!names[0].contains("provider"));
    assert!(!names[0].contains("account"));
}

#[cfg(unix)]
#[test]
fn durable_store_uses_private_unix_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempdir().unwrap();
    let store = FileSecretStore::open(root.path()).unwrap();
    let key = SecretKey::new("connector/private").unwrap();
    store
        .store(&key, &SecretValue::new(b"secret".to_vec()))
        .unwrap();
    let value = fs::read_dir(root.path().join("values"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();

    assert_eq!(
        fs::metadata(root.path()).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(value).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[cfg(unix)]
#[test]
fn durable_store_rejects_a_symlinked_values_directory() {
    use std::os::unix::fs::symlink;

    let profile = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let root = profile.path().join("secrets");
    let store = FileSecretStore::open(&root).unwrap();
    fs::remove_dir(root.join("values")).unwrap();
    symlink(outside.path(), root.join("values")).unwrap();

    let error = store
        .store(
            &SecretKey::new("connector/private").unwrap(),
            &SecretValue::new(b"secret".to_vec()),
        )
        .unwrap_err();

    assert_eq!(error.kind(), SecretStoreErrorKind::BackendFailure);
    assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
}

#[cfg(unix)]
#[test]
fn durable_store_rejects_a_symlinked_value_file() {
    use std::os::unix::fs::symlink;

    let root = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let store = FileSecretStore::open(root.path()).unwrap();
    let key = SecretKey::new("connector/private").unwrap();
    let outside_value = outside.path().join("value");
    fs::write(&outside_value, b"outside").unwrap();
    symlink(&outside_value, store.value_path(&key)).unwrap();

    let error = store
        .store(&key, &SecretValue::new(b"replacement".to_vec()))
        .unwrap_err();

    assert_eq!(error.kind(), SecretStoreErrorKind::BackendFailure);
    assert_eq!(fs::read(outside_value).unwrap(), b"outside");
}
