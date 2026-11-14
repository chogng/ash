//! Snapshot reads of a Thread's own committed voice observations, independent of Turns.
use crate::SessionId;
use crate::ThreadId;
use crate::VoiceTranscript;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceHistoryFilter {
    #[serde(default)]
    #[schemars(length(min = 1, max = 128))]
    pub voice_session_id: Option<String>,
    #[serde(default)]
    #[schemars(length(min = 1, max = 256))]
    pub event_id: Option<String>,
    #[serde(default)]
    #[ts(type = "number | null")]
    pub from_recorded_at_ms: Option<u64>,
    #[serde(default)]
    #[ts(type = "number | null")]
    pub to_recorded_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceHistoryQuery {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    #[serde(default)]
    pub filter: VoiceHistoryFilter,
    #[serde(default)]
    #[ts(type = "number")]
    pub after_sequence: u64,
    #[serde(default)]
    #[ts(type = "number | null")]
    pub snapshot_sequence: Option<u64>,
    /// Return pending until this acknowledged commit is readable.
    #[serde(default)]
    #[ts(type = "number | null")]
    pub required_sequence: Option<u64>,
    #[serde(default)]
    #[schemars(length(max = 8192))]
    pub cursor: Option<String>,
    #[schemars(range(min = 1, max = 500))]
    pub limit: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum VoiceHistoryCoverage {
    Ready,
    Pending,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VoiceHistoryEntry {
    pub event_id: String,
    #[ts(type = "number")]
    pub sequence: u64,
    #[ts(type = "number")]
    pub recorded_at_unix_ms: u64,
    /// Each entry is an immutable committed revision of a voice span.
    pub transcript: VoiceTranscript,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VoiceHistoryPage {
    pub entries: Vec<VoiceHistoryEntry>,
    pub next_cursor: Option<String>,
    #[ts(type = "number")]
    pub snapshot_sequence: u64,
    #[ts(type = "number")]
    pub committed_sequence: u64,
    pub coverage: VoiceHistoryCoverage,
}
