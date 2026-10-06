//! Session lifecycle summarized from its Threads, rather than stored independently.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Lifecycle summarized from the Threads carrying one `session_id`.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    Active,
    Archived,
}
