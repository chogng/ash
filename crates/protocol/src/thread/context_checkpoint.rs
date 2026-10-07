//! Verified summaries of exact durable history ranges for context compaction.

use crate::ContextCheckpointId;
use crate::ItemId;
use crate::ModelRef;
use crate::ThreadId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::fmt;
use ts_rs::TS;

/// Inclusive durable Thread sequence range summarized by one checkpoint.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContextSourceRange {
    #[ts(type = "number")]
    pub start_sequence: u64,
    #[ts(type = "number")]
    pub end_sequence: u64,
}

/// SHA-256 digest of the canonical source facts covered by a checkpoint.
#[derive(Clone, Debug, Eq, JsonSchema, PartialEq, TS)]
#[schemars(transparent)]
#[ts(type = "string")]
pub struct ContextSourceDigest(String);

impl ContextSourceDigest {
    pub fn new(value: impl Into<String>) -> Result<Self, InvalidContextSourceDigest> {
        let value = value.into();
        let valid = value.strip_prefix("sha256:").is_some_and(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        });
        if !valid {
            return Err(InvalidContextSourceDigest);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Serialize for ContextSourceDigest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ContextSourceDigest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidContextSourceDigest;

impl fmt::Display for InvalidContextSourceDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("context source digest must be a lowercase sha256 digest")
    }
}

impl std::error::Error for InvalidContextSourceDigest {}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ContextCheckpointVerification {
    Verified,
}

/// Verified durable summary of one exact prefix of Thread history.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContextCheckpoint {
    pub checkpoint_id: ContextCheckpointId,
    pub source_thread_id: ThreadId,
    pub covered: ContextSourceRange,
    pub referenced_items: Vec<ItemId>,
    pub source_digest: ContextSourceDigest,
    pub summary: String,
    pub schema_revision: String,
    pub prompt_revision: String,
    pub context_policy_revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub generator_model: Option<ModelRef>,
    #[ts(type = "number")]
    pub created_at_unix_ms: u64,
    pub verification: ContextCheckpointVerification,
}
