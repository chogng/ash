use crate::InvalidIdentifier;
use crate::ids::validate_identifier;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use std::fmt;
use ts_rs::TS;

/// Stable identity for one transient stream-emitter incarnation.
///
/// A new value is created whenever the emitter restarts. Its sequence is meaningful only within
/// that instance, so consumers must discard a previous cursor when this value changes.
#[derive(Clone, Debug, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize, TS)]
pub struct StreamInstanceId(#[schemars(length(min = 1))] String);

impl StreamInstanceId {
    pub fn new(value: impl Into<String>) -> Result<Self, InvalidIdentifier> {
        validate_identifier(value, "stream instance ID").map(Self)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for StreamInstanceId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for StreamInstanceId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// Ephemeral ordering cursor for updates that are not part of durable aggregate history.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StreamCursor {
    pub stream_instance_id: StreamInstanceId,
    #[ts(type = "number")]
    pub sequence: u64,
}
