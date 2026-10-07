use crate::SecretKey;
use crate::SecretStoreError;
use crate::SecretStoreErrorKind;
use crate::SecretValue;

/// Result of deleting an exact secret key.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeleteSecretOutcome {
    Deleted,
    NotFound,
}

/// Persists opaque secret values for domain runtimes.
///
/// Implementations are expected to provide complete load/store/delete behavior, isolate Ash's
/// namespace from other products, sanitize all errors, and never copy secret values into ordinary
/// configuration, logs, telemetry, command arguments, or durable product events.
pub trait SecretStore: Send + Sync {
    fn load(&self, key: &SecretKey) -> Result<Option<SecretValue>, SecretStoreError>;

    fn store(&self, key: &SecretKey, value: &SecretValue) -> Result<(), SecretStoreError>;

    fn delete(&self, key: &SecretKey) -> Result<DeleteSecretOutcome, SecretStoreError>;
}

/// Explicitly rejects secret access when a host has no configured secure facility.
#[derive(Default)]
pub struct UnavailableSecretStore;

impl SecretStore for UnavailableSecretStore {
    fn load(&self, _: &SecretKey) -> Result<Option<SecretValue>, SecretStoreError> {
        Err(unavailable())
    }

    fn store(&self, _: &SecretKey, _: &SecretValue) -> Result<(), SecretStoreError> {
        Err(unavailable())
    }

    fn delete(&self, _: &SecretKey) -> Result<DeleteSecretOutcome, SecretStoreError> {
        Err(unavailable())
    }
}

fn unavailable() -> SecretStoreError {
    SecretStoreError::new(
        SecretStoreErrorKind::BackendUnavailable,
        "secret store unavailable",
    )
}
