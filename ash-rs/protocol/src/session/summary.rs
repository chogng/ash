//! Session activity, status, and summary data derived from Thread facts.
//! These are displayable facts, not a session-manager runtime or lifecycle controller.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Canonical status used by products that present the total Session catalog.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SessionManagerStatus {
    #[default]
    Idle,
    NeedsInput,
    Working,
    ReadyForReview,
    Completed,
    Failed,
    Stopped,
}

/// Exact current activity safe to show without asking a summary model to infer lifecycle.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SessionManagerActivity {
    Operation { text: String },
    Question { text: String },
    Failure { text: String },
}

/// Read-only management facts derived from the durable Threads in one Session.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionManagerInfo {
    pub status: SessionManagerStatus,
    #[ts(type = "number")]
    pub status_changed_at_unix_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub activity: Option<SessionManagerActivity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub summary: Option<String>,
}
