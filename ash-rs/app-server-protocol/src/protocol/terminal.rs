use std::fmt;

use crate::JsonSchema;
use crate::TS;
use ash_protocol::SessionId;
use serde::Deserialize;
use serde::Serialize;

/// One server-owned shell profile available to interactive terminal clients.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfile {
    pub profile_id: String,
    pub title: String,
    pub is_default: bool,
}

/// Authorized terminal profiles discovered by the local App Server composition.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfileListResult {
    pub profiles: Vec<TerminalProfile>,
}

/// Selects either the server default or one previously listed authorized profile.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "type", deny_unknown_fields)]
pub enum TerminalProfileSelection {
    Default,
    Profile {
        #[serde(rename = "profileId")]
        #[ts(rename = "profileId")]
        profile_id: String,
    },
}

/// Selects whether a terminal dies with its creating connection or may be reattached briefly.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "type", deny_unknown_fields)]
pub enum TerminalLifecycle {
    ConnectionOwned,
    Reconnectable,
}

/// Starts one interactive terminal at the server's authorized directory.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalCreateParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[schemars(range(min = 1, max = 512))]
    pub rows: u16,
    #[schemars(range(min = 1, max = 512))]
    pub cols: u16,
    pub profile: TerminalProfileSelection,
    pub lifecycle: TerminalLifecycle,
}

/// Starts one interactive terminal in a session-authorized directory.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalCreateInSessionDirectoryParams {
    pub session_id: SessionId,
    pub path: std::path::PathBuf,
    #[schemars(range(min = 1, max = 512))]
    pub rows: u16,
    #[schemars(range(min = 1, max = 512))]
    pub cols: u16,
    pub profile: TerminalProfileSelection,
    pub lifecycle: TerminalLifecycle,
}

/// One short-lived bearer lease used to reattach a detached terminal.
#[derive(Clone, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalReconnectLease {
    #[schemars(length(min = 64, max = 64))]
    pub reconnect_token: String,
    #[ts(type = "number")]
    pub reconnect_grace_period_millis: u64,
}

impl fmt::Debug for TerminalReconnectLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TerminalReconnectLease")
            .field("reconnect_token", &"[REDACTED]")
            .field(
                "reconnect_grace_period_millis",
                &self.reconnect_grace_period_millis,
            )
            .finish()
    }
}

/// Identity allocated for one interactive terminal.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateResult {
    pub terminal_id: String,
    pub profile: TerminalProfile,
    pub reconnect: Option<TerminalReconnectLease>,
}

/// Reclaims one reconnectable terminal after its previous connection closed.
#[derive(Clone, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalAttachParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[schemars(length(min = 1))]
    pub terminal_id: String,
    #[schemars(length(min = 64, max = 64))]
    pub reconnect_token: String,
    #[schemars(range(min = 1, max = 512))]
    pub rows: u16,
    #[schemars(range(min = 1, max = 512))]
    pub cols: u16,
}

impl fmt::Debug for TerminalAttachParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TerminalAttachParams")
            .field("terminal_id", &self.terminal_id)
            .field("reconnect_token", &"[REDACTED]")
            .field("rows", &self.rows)
            .field("cols", &self.cols)
            .finish()
    }
}

/// Confirms attachment and rotates the bearer token for the next disconnect.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachResult {
    pub terminal_id: String,
    pub reconnect: TerminalReconnectLease,
}

/// Writes one bounded UTF-8 input batch to an interactive terminal.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalWriteParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[schemars(length(min = 1))]
    pub terminal_id: String,
    #[schemars(length(min = 1, max = 65536))]
    pub data: String,
}

/// Changes the PTY character-cell dimensions.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalResizeParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[schemars(length(min = 1))]
    pub terminal_id: String,
    #[schemars(range(min = 1, max = 512))]
    pub rows: u16,
    #[schemars(range(min = 1, max = 512))]
    pub cols: u16,
}

/// Reads output after the last sequence observed by this client.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalReadParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[schemars(length(min = 1))]
    pub terminal_id: String,
    #[ts(type = "number")]
    pub after_sequence: u64,
    #[ts(type = "number")]
    pub after_command_sequence: u64,
    #[schemars(range(min = 1, max = 128))]
    pub max_chunks: usize,
}

/// One ordered raw PTY output chunk encoded for JSON transport.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputChunk {
    #[ts(type = "number")]
    pub sequence: u64,
    pub data_base64: String,
}

/// Renderer-independent lifecycle state for one shell command.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TerminalCommandStatus {
    Running,
    Completed,
    Succeeded,
    Failed,
    Canceled,
}

/// One ordered command lifecycle transition associated with PTY output.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommandStatusEvent {
    #[ts(type = "number")]
    pub sequence: u64,
    pub command_id: String,
    pub status: TerminalCommandStatus,
    pub exit_code: Option<i32>,
    #[ts(type = "number")]
    pub after_output_sequence: u64,
}

/// Bounded output and process state for one interactive terminal.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReadResult {
    pub terminal_id: String,
    pub chunks: Vec<TerminalOutputChunk>,
    #[ts(type = "number")]
    pub next_sequence: u64,
    pub output_gap: bool,
    pub command_events: Vec<TerminalCommandStatusEvent>,
    #[ts(type = "number")]
    pub next_command_sequence: u64,
    pub command_event_gap: bool,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

/// Terminates and releases one terminal attached to the calling connection.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalCloseParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[schemars(length(min = 1))]
    pub terminal_id: String,
}
