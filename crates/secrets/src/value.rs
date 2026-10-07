use std::fmt;

use zeroize::Zeroize;

/// An opaque, non-secret identity used to address one value in a [`SecretStore`](crate::SecretStore).
///
/// Callers own the key schema. Keys should be stable across process restarts and must not contain
/// tokens, passwords, email addresses, or other sensitive values.
#[derive(Clone, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct SecretKey(String);

impl SecretKey {
    pub fn new(value: impl Into<String>) -> Result<Self, InvalidSecretKey> {
        let value = value.into();
        if value.is_empty() {
            return Err(InvalidSecretKey::Empty);
        }
        if value.len() > 512 {
            return Err(InvalidSecretKey::TooLong);
        }
        if value.chars().any(char::is_control) {
            return Err(InvalidSecretKey::ContainsControlCharacter);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("SecretKey").field(&self.0).finish()
    }
}

/// Validation failure for a [`SecretKey`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidSecretKey {
    Empty,
    TooLong,
    ContainsControlCharacter,
}

impl fmt::Display for InvalidSecretKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("secret key must not be empty"),
            Self::TooLong => formatter.write_str("secret key exceeds 512 characters"),
            Self::ContainsControlCharacter => {
                formatter.write_str("secret key must not contain control characters")
            }
        }
    }
}

impl std::error::Error for InvalidSecretKey {}

/// Opaque secret bytes that redact their `Debug` representation and clear memory on drop.
///
/// This type intentionally does not implement `Clone`, `Display`, serialization, or conversion
/// back to an owned string. Consumers should keep the borrow returned by [`Self::expose`] as short
/// lived as possible.
#[derive(Eq, PartialEq)]
pub struct SecretValue(Vec<u8>);

impl SecretValue {
    pub fn new(value: impl Into<Vec<u8>>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &[u8] {
        &self.0
    }
}

impl fmt::Debug for SecretValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretValue([REDACTED])")
    }
}

impl Drop for SecretValue {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
