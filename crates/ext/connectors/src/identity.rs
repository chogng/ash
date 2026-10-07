use std::fmt;

use crate::ConnectorError;
use crate::ConnectorErrorKind;

const MAX_CONNECTOR_ID_BYTES: usize = 256;
const MAX_ACCOUNT_ID_BYTES: usize = 512;
const MAX_CREDENTIAL_REF_BYTES: usize = 1024;

/// Stable identity for one connectable external product declaration.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ConnectorId(String);

impl ConnectorId {
    pub fn new(value: impl Into<String>) -> Result<Self, ConnectorError> {
        let value = value.into();
        validate_identity("connector ID", &value, MAX_CONNECTOR_ID_BYTES)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ConnectorId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Provider-owned identity of the external account connected to one Connector.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ConnectorAccountId(String);

impl ConnectorAccountId {
    pub fn new(value: impl Into<String>) -> Result<Self, ConnectorError> {
        let value = value.into();
        validate_identity("connector account ID", &value, MAX_ACCOUNT_ID_BYTES)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Non-secret reference to credential material owned by an authentication adapter.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ConnectorCredentialRef(String);

impl ConnectorCredentialRef {
    pub fn new(value: impl Into<String>) -> Result<Self, ConnectorError> {
        let value = value.into();
        validate_identity(
            "connector credential reference",
            &value,
            MAX_CREDENTIAL_REF_BYTES,
        )?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Monotonic identity of one immutable Connector catalog projection.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ConnectorSnapshotGeneration(u64);

impl ConnectorSnapshotGeneration {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

/// Monotonic identity of one account connection attempt or revocation.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ConnectorConnectionGeneration(u64);

impl ConnectorConnectionGeneration {
    pub const INITIAL: Self = Self(0);

    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

fn validate_identity(label: &str, value: &str, maximum_bytes: usize) -> Result<(), ConnectorError> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > maximum_bytes
        || value.chars().any(char::is_control)
    {
        return Err(ConnectorError::new(
            ConnectorErrorKind::InvalidIdentity,
            format!("{label} must be bounded non-empty plain text without surrounding whitespace"),
        ));
    }
    Ok(())
}
