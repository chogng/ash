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

/// Reads selected values from the authorized execution environment without spawning a process.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalEnvironmentReadParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[schemars(length(max = 128))]
    pub names: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEnvironmentReadResult {
    pub values: std::collections::BTreeMap<String, String>,
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

/// Selects a one-shot execution instead of an interactive shell.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum TerminalExecution {
    Process { program: String, args: Vec<String> },
    Shell {
        #[serde(rename = "commandLine")]
        command_line: String,
    },
}

/// Starts one terminal process in the server's authorized directory.
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub env: Option<std::collections::BTreeMap<String, Option<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cwd: Option<std::path::PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub execution: Option<TerminalExecution>,
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

/// OS identity and the directory actually passed to the shell at spawn.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProcessReady {
    #[schemars(range(min = 1))]
    pub pid: u32,
    pub cwd: String,
}

/// Backend-owned properties. Current cwd is null when the OS cannot query it or the shell exited.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProcessInfo {
    pub ready: TerminalProcessReady,
    pub cwd: Option<String>,
    pub rows: u16,
    pub cols: u16,
}

/// Queries process properties without confusing the launch directory with current cwd.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalProcessInfoParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[schemars(length(min = 1))]
    pub terminal_id: String,
}

/// A process-control signal supported by the PTY backend, independent of input encoding.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TerminalSignal {
    Interrupt,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalSendSignalParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[schemars(length(min = 1))]
    pub terminal_id: String,
    pub signal: TerminalSignal,
}

/// Identity allocated for one interactive terminal.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateResult {
    pub ready: TerminalProcessReady,
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
    pub ready: TerminalProcessReady,
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

/// Writes raw bytes such as xterm's legacy mouse reports, with a 64 KiB decoded limit.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalWriteBinaryParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[schemars(length(min = 1))]
    pub terminal_id: String,
    #[schemars(length(min = 4, max = 87384))]
    pub data_base64: String,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_create_environment_preserves_overrides_and_removals() {
        let value = serde_json::json!({
            "rows": 24, "cols": 80, "profile": {"type": "default"},
            "lifecycle": {"type": "connectionOwned"},
            "env": {"MODE": "task value", "REMOVE": null}
        });
        let request: TerminalCreateParams = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), value);
        let original = serde_json::json!({
            "rows": 24, "cols": 80, "profile": {"type": "default"},
            "lifecycle": {"type": "connectionOwned"}
        });
        let request: TerminalCreateParams = serde_json::from_value(original.clone()).unwrap();
        assert!(request.env.is_none());
        assert_eq!(serde_json::to_value(request).unwrap(), original);
    }

    #[test]
    fn terminal_environment_query_has_no_process_creation_fields() {
        let value = serde_json::json!({"names": ["HOME", "PATH"], "dirId": "workspace"});
        let request: TerminalEnvironmentReadParams = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), value);
        assert!(
            serde_json::from_value::<TerminalEnvironmentReadParams>(
                serde_json::json!({"names": [], "env": {"MODE": "changed"}})
            )
            .is_err()
        );
    }
}
