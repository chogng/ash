use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use std::fmt;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

static NEXT_RUN_ID: AtomicU64 = AtomicU64::new(1);

/// Stable identity for one invocation of the headless runner.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(transparent)]
pub struct ExecRunId(#[cfg_attr(feature = "schema", schemars(length(min = 1)))] String);

impl ExecRunId {
    /// Validates an externally supplied run identity.
    pub fn new(value: impl Into<String>) -> Result<Self, InvalidExecRunId> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(InvalidExecRunId);
        }
        Ok(Self(value))
    }

    /// Creates a process-local unique identity suitable for command correlation.
    pub fn generate() -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let sequence = NEXT_RUN_ID.fetch_add(1, Ordering::Relaxed);
        Self(format!("run-{}-{timestamp}-{sequence}", std::process::id()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ExecRunId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ExecRunId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// Returned when a caller supplies an empty headless run identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidExecRunId;

impl fmt::Display for InvalidExecRunId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("exec run ID must not be empty")
    }
}

impl std::error::Error for InvalidExecRunId {}

#[cfg(test)]
#[path = "run_id_tests.rs"]
mod tests;
