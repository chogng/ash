use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;

use ash_secrets::DeleteSecretOutcome;
use ash_secrets::SecretKey;
use ash_secrets::SecretStore;
use ash_secrets::SecretStoreErrorKind;
use ash_secrets::SecretValue;
use tempfile::tempdir;

use super::KEYRING_SERVICE;
use super::KeyringBackend;
use super::KeyringBackendError;
use super::KeyringSecretStore;
use super::MAX_SECRET_BYTES;
use super::profile_namespace;

#[derive(Default)]
struct FakeKeyringBackend {
    values: Mutex<BTreeMap<(String, String), Vec<u8>>>,
    failure: Mutex<Option<KeyringBackendError>>,
}

impl FakeKeyringBackend {
    fn fail_with(&self, error: KeyringBackendError) {
        *self.failure.lock().unwrap() = Some(error);
    }

    fn accounts(&self) -> Vec<String> {
        self.values
            .lock()
            .unwrap()
            .keys()
            .map(|(_, account)| account.clone())
            .collect()
    }

    fn operation_failure(&self) -> Result<(), KeyringBackendError> {
        match *self.failure.lock().unwrap() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

impl KeyringBackend for FakeKeyringBackend {
    fn load(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, KeyringBackendError> {
        self.operation_failure()?;
        Ok(self
            .values
            .lock()
            .unwrap()
            .get(&(service.to_string(), account.to_string()))
            .cloned())
    }

    fn store(&self, service: &str, account: &str, value: &[u8]) -> Result<(), KeyringBackendError> {
        self.operation_failure()?;
        self.values
            .lock()
            .unwrap()
            .insert((service.to_string(), account.to_string()), value.to_vec());
        Ok(())
    }

    fn delete(
        &self,
        service: &str,
        account: &str,
    ) -> Result<DeleteSecretOutcome, KeyringBackendError> {
        self.operation_failure()?;
        Ok(
            if self
                .values
                .lock()
                .unwrap()
                .remove(&(service.to_string(), account.to_string()))
                .is_some()
            {
                DeleteSecretOutcome::Deleted
            } else {
                DeleteSecretOutcome::NotFound
            },
        )
    }
}

fn store(namespace: [u8; 32], backend: Arc<FakeKeyringBackend>) -> KeyringSecretStore {
    let backend_port: Arc<dyn KeyringBackend> = backend;
    KeyringSecretStore::with_backend(namespace, backend_port)
}

#[test]
fn binary_values_round_trip_replace_and_delete() {
    let backend = Arc::new(FakeKeyringBackend::default());
    let store = store([7; 32], backend);
    let key = SecretKey::new("connector/acme/account").unwrap();

    assert!(store.load(&key).unwrap().is_none());
    store
        .store(&key, &SecretValue::new(vec![0, 1, 2, 255]))
        .unwrap();
    assert_eq!(store.load(&key).unwrap().unwrap().expose(), &[0, 1, 2, 255]);
    store
        .store(&key, &SecretValue::new(b"replacement".to_vec()))
        .unwrap();
    assert_eq!(store.load(&key).unwrap().unwrap().expose(), b"replacement");
    assert_eq!(store.delete(&key).unwrap(), DeleteSecretOutcome::Deleted);
    assert_eq!(store.delete(&key).unwrap(), DeleteSecretOutcome::NotFound);
}

#[test]
fn profile_and_key_metadata_are_hashed_before_reaching_the_backend() {
    let backend = Arc::new(FakeKeyringBackend::default());
    let first = store([1; 32], Arc::clone(&backend));
    let second = store([2; 32], Arc::clone(&backend));
    let key = SecretKey::new("provider/account@example.com/token").unwrap();

    first
        .store(&key, &SecretValue::new(b"first".to_vec()))
        .unwrap();
    second
        .store(&key, &SecretValue::new(b"second".to_vec()))
        .unwrap();

    let accounts = backend.accounts();
    assert_eq!(accounts.len(), 2);
    assert!(accounts.iter().all(|account| account.len() == 64));
    assert!(accounts.iter().all(|account| !account.contains("account")));
    assert_eq!(first.load(&key).unwrap().unwrap().expose(), b"first");
    assert_eq!(second.load(&key).unwrap().unwrap().expose(), b"second");
}

#[test]
fn canonical_profile_paths_produce_stable_isolated_namespaces() {
    let first = tempdir().unwrap();
    let second = tempdir().unwrap();
    let first_path = std::fs::canonicalize(first.path()).unwrap();

    assert_eq!(
        profile_namespace(&first_path),
        profile_namespace(&first_path)
    );
    assert_ne!(
        profile_namespace(&first_path),
        profile_namespace(&std::fs::canonicalize(second.path()).unwrap())
    );
}

#[test]
fn backend_errors_are_classified_and_sanitized() {
    let backend = Arc::new(FakeKeyringBackend::default());
    let store = store([3; 32], Arc::clone(&backend));
    let key = SecretKey::new("sensitive-key-name").unwrap();
    backend.fail_with(KeyringBackendError::AccessDenied);

    let error = store.load(&key).unwrap_err();
    assert_eq!(error.kind(), SecretStoreErrorKind::AccessDenied);
    assert_eq!(error.to_string(), "keyring operation failed");
    assert!(!error.to_string().contains(key.as_str()));
}

#[test]
fn oversized_values_fail_before_reaching_the_backend() {
    let backend = Arc::new(FakeKeyringBackend::default());
    let store = store([4; 32], Arc::clone(&backend));
    let key = SecretKey::new("oversized").unwrap();

    let error = store
        .store(&key, &SecretValue::new(vec![7; MAX_SECRET_BYTES + 1]))
        .unwrap_err();
    assert_eq!(error.kind(), SecretStoreErrorKind::BackendFailure);
    assert!(backend.accounts().is_empty());
}

#[test]
fn system_service_identity_is_stable_and_nonempty() {
    assert_eq!(KEYRING_SERVICE, "com.ash.secret-store.v1");
}

#[cfg(target_os = "macos")]
#[test]
fn macos_background_operations_are_silent_and_authorization_does_not_leak() {
    use security_framework::os::macos::keychain::SecKeychain;

    struct InspectStore;
    impl SecretStore for InspectStore {
        fn check_availability(&self) -> Result<(), ash_secrets::SecretStoreError> {
            super::with_keyring_access(|| {
                assert!(SecKeychain::user_interaction_allowed().unwrap());
                Ok(())
            })
            .map_err(super::backend_error)
        }
        fn load(
            &self,
            _: &SecretKey,
        ) -> Result<Option<SecretValue>, ash_secrets::SecretStoreError> {
            unreachable!()
        }
        fn store(
            &self,
            _: &SecretKey,
            _: &SecretValue,
        ) -> Result<(), ash_secrets::SecretStoreError> {
            unreachable!()
        }
        fn delete(
            &self,
            _: &SecretKey,
        ) -> Result<DeleteSecretOutcome, ash_secrets::SecretStoreError> {
            unreachable!()
        }
    }
    assert!(SecKeychain::user_interaction_allowed().unwrap());
    super::with_user_authorization(|| InspectStore.check_availability()).unwrap();
    std::thread::scope(|scope| {
        for _ in 0..8 {
            scope.spawn(|| {
                super::with_keyring_access(|| {
                    assert!(!SecKeychain::user_interaction_allowed().unwrap());
                    Ok(())
                })
                .unwrap()
            });
        }
    });
    assert!(SecKeychain::user_interaction_allowed().unwrap());
}

#[cfg(target_os = "macos")]
#[test]
fn macos_authentication_required_errors_are_access_denied_and_sanitized() {
    for code in [-25293, -25308, -25315] {
        let error = keyring::Error::PlatformFailure(Box::new(
            security_framework::base::Error::from_code(code),
        ));
        let error = super::backend_error(super::classify_keyring_error(&error));
        assert_eq!(error.kind(), SecretStoreErrorKind::AccessDenied);
        assert_eq!(error.to_string(), "keyring operation failed");
    }
    let error =
        keyring::Error::PlatformFailure(Box::new(security_framework::base::Error::from_code(-50)));
    assert_eq!(
        super::backend_error(super::classify_keyring_error(&error)).kind(),
        SecretStoreErrorKind::BackendFailure
    );
}
