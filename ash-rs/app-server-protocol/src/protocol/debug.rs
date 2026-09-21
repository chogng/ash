use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

/// Starts one connection-owned stdio Debug Adapter Protocol process.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugAdapterStartParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[schemars(length(min = 1, max = 4096))]
    pub program: String,
    #[schemars(length(max = 128))]
    pub arguments: Vec<String>,
}

/// Opaque identity allocated for one adapter process.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DebugAdapterStartResult {
    pub session_id: String,
}

/// Sends one complete DAP message to an owned adapter.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugAdapterSendParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    pub session_id: String,
    #[ts(type = "unknown")]
    pub message: Value,
}

/// Reads a bounded batch of adapter messages after a transport sequence.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugAdapterReadParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    pub session_id: String,
    #[ts(type = "number")]
    pub after_sequence: u64,
    #[schemars(range(min = 1, max = 128))]
    pub max_messages: usize,
}

/// One ordered adapter message retained by the App Server.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DebugAdapterMessageDto {
    #[ts(type = "number")]
    pub sequence: u64,
    #[ts(type = "unknown")]
    pub message: Value,
}

/// Bounded adapter output and process state.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DebugAdapterReadResult {
    pub messages: Vec<DebugAdapterMessageDto>,
    #[ts(type = "number")]
    pub next_sequence: u64,
    pub output_gap: bool,
    pub stderr: String,
    pub exited: bool,
    pub exit_code: Option<i32>,
    pub protocol_error: Option<String>,
}

/// Terminates and releases one connection-owned adapter process.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugAdapterCloseParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    pub session_id: String,
}
