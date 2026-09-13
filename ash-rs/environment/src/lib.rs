//! Shared identity for an execution environment.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;
use ts_rs::TS;

const LOCAL_ENV_ID: &str = "local";

/// Stable host-selected identity for one execution and filesystem environment.
#[derive(
    Clone, Debug, Deserialize, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize, TS,
)]
#[schemars(transparent)]
#[ts(type = "string")]
pub struct EnvId(String);

impl EnvId {
    pub fn new(value: impl Into<String>) -> Result<Self, EnvIdError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(EnvIdError);
        }
        Ok(Self(value))
    }

    /// Identifies the host-local execution environment.
    pub fn local() -> Self {
        Self(LOCAL_ENV_ID.to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for EnvId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl FromStr for EnvId {
    type Err = EnvIdError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EnvIdError;

impl fmt::Display for EnvIdError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("environment ID must not be empty")
    }
}

impl std::error::Error for EnvIdError {}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;

mod directory;
pub use directory::DirPathError;
pub use directory::Directory;
pub use directory::LocalFileDriver;
