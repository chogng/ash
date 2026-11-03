use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MessageHistoryKind {
    Agent,
    Shell,
    Command,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MessageHistoryAppendParams {
    pub text: String,
    pub kind: MessageHistoryKind,
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MessageHistoryEntry {
    /// Decimal identities preserve SQLite cursor precision in JavaScript clients.
    pub id: String,
    #[ts(type = "number")]
    pub submitted_at_ms: u64,
    pub text: String,
    pub kind: MessageHistoryKind,
    pub thread_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MessageHistoryReadParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    pub before: Option<String>,
    pub text: String,
    pub kind: Option<MessageHistoryKind>,
    pub limit: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MessageHistoryPage {
    pub entries: Vec<MessageHistoryEntry>,
    pub next_before: Option<String>,
}
