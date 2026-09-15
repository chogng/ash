//! OS keyring adapter for Ash's provider-neutral secret persistence contract.
//!
//! This crate owns platform keyring access, profile namespace isolation, explicitly named
//! credential entry operations, and sanitized backend errors. Authentication and revocation
//! remain with the domain runtime that supplies [`SecretKey`].

use std::fmt::Write as _;
use std::path::Path;
use std::sync::Arc;

use ash_secrets::DeleteSecretOutcome;
use ash_secrets::SecretKey;
use ash_secrets::SecretStore;
use ash_secrets::SecretStoreError;
use ash_secrets::SecretStoreErrorKind;
use ash_secrets::SecretValue;
use keyring::Entry;
use sha2::Digest;
use sha2::Sha256;

const KEYRING_SERVICE: &str = "com.ash.secret-store.v1";
const PROFILE_NAMESPACE_DOMAIN: &[u8] = b"ash-keyring-profile-namespace-v1\0";
const ACCOUNT_DOMAIN: &[u8] = b"ash-keyring-account-v1\0";
const MAX_SECRET_BYTES: usize = 1024 * 1024;

/// Reads an existing product-owned keyring entry without creating, updating, or deleting it.
pub fn read_credential(
    service: &str,
    account: &str,
) -> Result<Option<SecretValue>, SecretStoreError> {
    ensure_supported_platform()?;
    SystemKeyringBackend
        .load(service, account)
        .map(|value| value.map(SecretValue::new))
        .map_err(backend_error)
}

/// Writes one explicitly selected credential entry after its owning domain authorizes the update.
pub fn write_credential(
    service: &str,
    account: &str,
    value: &SecretValue,
) -> Result<(), SecretStoreError> {
    ensure_supported_platform()?;
    if value.expose().len() > MAX_SECRET_BYTES {
        return Err(sanitized_error(
            SecretStoreErrorKind::BackendFailure,
            "credential exceeds keyring size limit",
        ));
    }
    SystemKeyringBackend
        .store(service, account, value.expose())
        .map_err(backend_error)
}

/// Deletes one explicitly selected entry after its owning domain authorizes logout.
pub fn delete_credential(
    service: &str,
    account: &str,
) -> Result<DeleteSecretOutcome, SecretStoreError> {
    ensure_supported_platform()?;
    SystemKeyringBackend
        .delete(service, account)
        .map_err(backend_error)
}

/// A `SecretStore` backed by the current platform's native credential facility.
///
/// Callers construct one store per canonical profile root. Both the profile path and logical
/// secret key are domain-separated and hashed before becoming a keyring account, so OS-visible
/// metadata contains neither path text nor the caller's key schema.
pub struct KeyringSecretStore {
    profile_namespace: [u8; 32],
    backend: Arc<dyn KeyringBackend>,
}

impl KeyringSecretStore {
    /// Creates a store isolated to one existing, canonicalizable Ash profile directory.
    pub fn for_profile(profile_root: impl AsRef<Path>) -> Result<Self, SecretStoreError> {
        ensure_supported_platform()?;
        let profile_root = std::fs::canonicalize(profile_root).map_err(|_| {
            sanitized_error(
                SecretStoreErrorKind::BackendUnavailable,
                "keyring profile namespace is unavailable",
            )
        })?;
        Ok(Self {
            profile_namespace: profile_namespace(&profile_root),
            backend: Arc::new(SystemKeyringBackend),
        })
    }

    #[cfg(test)]
    fn with_backend(profile_namespace: [u8; 32], backend: Arc<dyn KeyringBackend>) -> Self {
        Self {
            profile_namespace,
            backend,
        }
    }

    fn account(&self, key: &SecretKey) -> String {
        let mut digest = Sha256::new();
        digest.update(ACCOUNT_DOMAIN);
        digest.update(self.profile_namespace);
        digest.update((key.as_str().len() as u64).to_be_bytes());
        digest.update(key.as_str().as_bytes());
        hex_digest(digest.finalize())
    }
}

impl SecretStore for KeyringSecretStore {
    fn load(&self, key: &SecretKey) -> Result<Option<SecretValue>, SecretStoreError> {
        self.backend
            .load(KEYRING_SERVICE, &self.account(key))
            .map(|value| value.map(SecretValue::new))
            .map_err(backend_error)
    }

    fn store(&self, key: &SecretKey, value: &SecretValue) -> Result<(), SecretStoreError> {
        if value.expose().len() > MAX_SECRET_BYTES {
            return Err(sanitized_error(
                SecretStoreErrorKind::BackendFailure,
                "secret value exceeds the keyring size limit",
            ));
        }
        self.backend
            .store(KEYRING_SERVICE, &self.account(key), value.expose())
            .map_err(backend_error)
    }

    fn delete(&self, key: &SecretKey) -> Result<DeleteSecretOutcome, SecretStoreError> {
        self.backend
            .delete(KEYRING_SERVICE, &self.account(key))
            .map_err(backend_error)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum KeyringBackendError {
    AccessDenied,
    Failure,
}

trait KeyringBackend: Send + Sync {
    fn load(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, KeyringBackendError>;

    fn store(&self, service: &str, account: &str, value: &[u8]) -> Result<(), KeyringBackendError>;

    fn delete(
        &self,
        service: &str,
        account: &str,
    ) -> Result<DeleteSecretOutcome, KeyringBackendError>;
}

struct SystemKeyringBackend;

impl KeyringBackend for SystemKeyringBackend {
    fn load(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, KeyringBackendError> {
        let entry = entry(service, account)?;
        match entry.get_secret() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(classify_keyring_error(&error)),
        }
    }

    fn store(&self, service: &str, account: &str, value: &[u8]) -> Result<(), KeyringBackendError> {
        entry(service, account)?
            .set_secret(value)
            .map_err(|error| classify_keyring_error(&error))
    }

    fn delete(
        &self,
        service: &str,
        account: &str,
    ) -> Result<DeleteSecretOutcome, KeyringBackendError> {
        match entry(service, account)?.delete_credential() {
            Ok(()) => Ok(DeleteSecretOutcome::Deleted),
            Err(keyring::Error::NoEntry) => Ok(DeleteSecretOutcome::NotFound),
            Err(error) => Err(classify_keyring_error(&error)),
        }
    }
}

fn entry(service: &str, account: &str) -> Result<Entry, KeyringBackendError> {
    Entry::new(service, account).map_err(|error| classify_keyring_error(&error))
}

fn classify_keyring_error(error: &keyring::Error) -> KeyringBackendError {
    match error {
        keyring::Error::NoStorageAccess(_) => KeyringBackendError::AccessDenied,
        _ => KeyringBackendError::Failure,
    }
}

fn backend_error(error: KeyringBackendError) -> SecretStoreError {
    let kind = match error {
        KeyringBackendError::AccessDenied => SecretStoreErrorKind::AccessDenied,
        KeyringBackendError::Failure => SecretStoreErrorKind::BackendFailure,
    };
    sanitized_error(kind, "keyring operation failed")
}

fn sanitized_error(kind: SecretStoreErrorKind, message: &'static str) -> SecretStoreError {
    SecretStoreError::new(kind, message)
}

#[cfg(any(
    target_os = "freebsd",
    target_os = "linux",
    target_os = "macos",
    target_os = "openbsd",
    target_os = "windows"
))]
fn ensure_supported_platform() -> Result<(), SecretStoreError> {
    Ok(())
}

#[cfg(not(any(
    target_os = "freebsd",
    target_os = "linux",
    target_os = "macos",
    target_os = "openbsd",
    target_os = "windows"
)))]
fn ensure_supported_platform() -> Result<(), SecretStoreError> {
    Err(sanitized_error(
        SecretStoreErrorKind::BackendUnavailable,
        "native keyring storage is unavailable on this platform",
    ))
}

fn profile_namespace(profile_root: &Path) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(PROFILE_NAMESPACE_DOMAIN);
    update_path_digest(&mut digest, profile_root);
    digest.finalize().into()
}

#[cfg(unix)]
fn update_path_digest(digest: &mut Sha256, path: &Path) {
    use std::os::unix::ffi::OsStrExt as _;

    let bytes = path.as_os_str().as_bytes();
    digest.update((bytes.len() as u64).to_be_bytes());
    digest.update(bytes);
}

#[cfg(windows)]
fn update_path_digest(digest: &mut Sha256, path: &Path) {
    use std::os::windows::ffi::OsStrExt as _;

    let units = path.as_os_str().encode_wide().collect::<Vec<_>>();
    digest.update((units.len() as u64).to_be_bytes());
    for unit in units {
        digest.update(unit.to_be_bytes());
    }
}

#[cfg(not(any(unix, windows)))]
fn update_path_digest(digest: &mut Sha256, path: &Path) {
    let value = path.as_os_str().to_string_lossy();
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value.as_bytes());
}

fn hex_digest(bytes: impl IntoIterator<Item = u8>) -> String {
    let mut value = String::with_capacity(64);
    for byte in bytes {
        write!(value, "{byte:02x}").expect("writing to a String cannot fail");
    }
    value
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
