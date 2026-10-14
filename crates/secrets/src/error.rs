use std::error::Error;
use std::fmt;

/// Stable classification for a secret-store failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SecretStoreErrorKind {
    BackendUnavailable,
    AccessDenied,
    BackendFailure,
    /// Encrypted data exists but its system-keyring key is missing.
    KeyMissing,
    /// A stored encryption key or authenticated ciphertext is invalid.
    InvalidData,
    /// Legacy values could not be safely committed to encrypted storage.
    MigrationFailed,
}

/// A sanitized secret-store failure.
///
/// Backends must not place a secret value, command line, authorization header, or raw backend
/// response in `message`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SecretStoreError {
    kind: SecretStoreErrorKind,
    message: String,
}

impl SecretStoreError {
    pub fn new(kind: SecretStoreErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn kind(&self) -> SecretStoreErrorKind {
        self.kind
    }
}

impl fmt::Display for SecretStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for SecretStoreError {}
