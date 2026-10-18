use std::fmt;

use crate::JsonSchema;
use crate::TS;
use ash_protocol::SessionId;
use serde::Deserialize;
use serde::Serialize;

/// Literal argv, or a pre-escaped Windows command-line tail.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(untagged)]
pub enum TerminalArguments {
    Argv(#[schemars(length(max = 1024))] Vec<String>),
    CommandLine(#[schemars(length(max = 32768))] String),
}

/// One server-owned shell profile available to interactive terminal clients.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfile {
    pub profile_id: String,
    pub title: String,
    pub is_default: bool,
}

/// Selects the authorized execution directory for shell profile discovery.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalProfileListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
}

/// Authorized terminal profiles discovered by the local App Server composition.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfileListResult {
    pub profiles: Vec<TerminalProfile>,
}

/// Reads named values or the filtered execution environment without spawning a process.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalEnvironmentReadParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[schemars(length(max = 128))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub names: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEnvironmentReadResult {
    pub values: std::collections::BTreeMap<String, String>,
}

/// Selects the server default, a discovered profile, or an execution-host-validated custom shell.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "type", deny_unknown_fields)]
pub enum TerminalProfileSelection {
    Default,
    Profile {
        #[serde(rename = "profileId")]
        #[ts(rename = "profileId")]
        profile_id: String,
    },
    Custom {
        #[schemars(length(min = 1, max = 256))]
        name: String,
        #[schemars(length(min = 1, max = 32))]
        path: Vec<String>,
        args: TerminalArguments,
    },
}

/// Validates the selected shell on the authorized execution host without spawning it.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalProfileResolveParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    pub profile: TerminalProfileSelection,
}

/// Execution-host resolution, including the actual executable and literal arguments.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfileResolveResult {
    pub profile: TerminalProfile,
    pub executable: String,
    pub args: TerminalArguments,
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
    Process {
        program: String,
        args: TerminalArguments,
    },
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
    pub strict_env: Option<bool>,
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
    /// Shell identified by the execution owner; absent for unrecognized executables.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub shell_type: Option<TerminalShellType>,
}

/// Backend-owned properties. Shell-reported cwd survives exit; cwd is absent when unavailable.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProcessInfo {
    pub ready: TerminalProcessReady,
    pub cwd: Option<String>,
    pub rows: u16,
    pub cols: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub has_child_processes: Option<bool>,
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

/// Shells with an integrated display protocol, selected by the execution host.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Eq, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "lowercase")]
pub enum TerminalShellType {
    Bash,
    Zsh,
    #[serde(rename = "pwsh")]
    PowerShell,
}

/// Shell display boundaries verified and decoded by the PTY owner, in output order.
#[derive(Serialize, Deserialize, Clone, Eq, PartialEq, JsonSchema, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalShellIntegrationEvent {
    ProcessReady {
        is_windows_pty: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        shell_type: Option<TerminalShellType>,
    },
    PromptStart,
    CommandStart,
    CommandExecuted {
        command_id: String,
        command: Option<String>,
        is_trusted: bool,
        #[serde(default)]
        command_storage_disabled: bool,
        cwd: Option<String>,
        #[ts(type = "number")]
        timestamp_millis: u64,
    },
    CommandFinished {
        exit_code: Option<i32>,
        #[ts(type = "number | null")]
        duration_millis: Option<u64>,
    },
    CommandLine {
        value: String,
        is_trusted: bool,
    },
    ContinuationStart,
    ContinuationEnd,
    RightPromptStart,
    RightPromptEnd,
    Cwd {
        value: String,
        is_trusted: bool,
    },
    HasRichCommandDetection {
        value: bool,
    },
    CommandStorageDisabled,
    PromptType {
        value: String,
    },
    Environment {
        values: Option<std::collections::BTreeMap<String, Option<String>>>,
        is_trusted: bool,
    },
    EnvironmentStart {
        clear: bool,
        is_trusted: bool,
    },
    EnvironmentEntry {
        key: String,
        value: Option<String>,
        is_trusted: bool,
    },
    EnvironmentDelete {
        key: String,
        value: Option<String>,
        is_trusted: bool,
    },
    EnvironmentEnd {
        is_trusted: bool,
    },
}

/// One ordered raw PTY output chunk encoded for JSON transport.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputChunk {
    #[ts(type = "number")]
    pub sequence: u64,
    pub data_base64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub shell_integration: Option<TerminalShellIntegrationEvent>,
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

/// Last shell-reported directory, ordered against the retained output stream.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCwd {
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub is_trusted: Option<bool>,
    #[ts(type = "number")]
    pub after_output_sequence: u64,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub command: Option<String>,
    /// Only command-text provenance; this grants no execution or path authority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub is_trusted: Option<bool>,
}

/// Detected protocol support and bounded completed commands owned by this PTY.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalShellIntegration {
    pub command_detection: bool,
    pub cwd_detection: bool,
    pub has_rich_command_detection: bool,
    pub command_storage_disabled: bool,
    /// Prompt framework identity reported by the shell; carries no execution trust.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prompt_type: Option<String>,
    pub commands: Vec<TerminalCommandStatusEvent>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cwd: Option<TerminalCwd>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub shell_integration: Option<TerminalShellIntegration>,
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
    fn terminal_display_metadata_uses_camel_case_and_redacts_debug_payloads() {
        let value = serde_json::json!({
            "type": "environmentEntry", "key": "TOKEN", "value": "private-value", "isTrusted": true
        });
        let event: TerminalShellIntegrationEvent = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&event).unwrap(), value);
        assert_eq!(format!("{event:?}"), "EnvironmentEntry { .. }");
    }

    #[test]
    fn terminal_shell_type_is_optional_for_legacy_ready_frames() {
        let legacy = serde_json::json!({"type": "processReady", "isWindowsPty": false});
        let event: TerminalShellIntegrationEvent = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(serde_json::to_value(event).unwrap(), legacy);
        let current =
            serde_json::json!({"type": "processReady", "isWindowsPty": true, "shellType": "pwsh"});
        let event: TerminalShellIntegrationEvent = serde_json::from_value(current.clone()).unwrap();
        assert_eq!(serde_json::to_value(event).unwrap(), current);
    }

    #[test]
    fn strict_environment_is_optional_and_rejects_non_boolean_requests() {
        let mut value = serde_json::json!({"rows": 24, "cols": 80, "profile": {"type": "default"}, "lifecycle": {"type": "connectionOwned"}});
        let legacy: TerminalCreateParams = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(legacy.strict_env, None);
        assert_eq!(serde_json::to_value(legacy).unwrap(), value);
        for strict in [true, false] {
            value["strictEnv"] = serde_json::json!(strict);
            let request: TerminalCreateParams = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(request.strict_env, Some(strict));
            assert_eq!(serde_json::to_value(request).unwrap(), value);
        }
        value["strictEnv"] = serde_json::json!("true");
        assert!(serde_json::from_value::<TerminalCreateParams>(value).is_err());
    }

    #[test]
    fn terminal_command_line_and_argv_round_trip_without_changing_representation() {
        for args in [
            serde_json::json!(r#"/d /s /c "echo two words & literal;$HOME""#),
            serde_json::json!(["", "two words", r#"a"b\"#]),
            serde_json::json!(""),
        ] {
            let profile = serde_json::json!({"type": "custom", "name": "Windows shell", "path": ["cmd.exe"], "args": args});
            let resolve = serde_json::json!({"profile": profile});
            let request: TerminalProfileResolveParams =
                serde_json::from_value(resolve.clone()).unwrap();
            assert_eq!(serde_json::to_value(request).unwrap(), resolve);
            let create = serde_json::json!({"rows": 24, "cols": 80, "profile": profile, "lifecycle": {"type": "connectionOwned"}, "execution": {"type": "process", "program": "cmd.exe", "args": args}});
            let request: TerminalCreateParams = serde_json::from_value(create.clone()).unwrap();
            assert_eq!(serde_json::to_value(request).unwrap(), create);
        }
        for invalid in [
            serde_json::json!(42),
            serde_json::json!([null]),
            serde_json::json!({"raw": "echo"}),
        ] {
            assert!(serde_json::from_value::<TerminalArguments>(invalid).is_err());
        }
    }

    #[test]
    fn terminal_read_preserves_optional_cwd_and_unknown_command_exit_status() {
        let original = serde_json::json!({"terminalId": "terminal", "chunks": [], "nextSequence": 4, "outputGap": false, "commandEvents": [{"sequence": 1, "commandId": "command", "status": "completed", "exitCode": null, "afterOutputSequence": 4}], "nextCommandSequence": 1, "commandEventGap": false, "exited": false, "exitCode": null});
        let read: TerminalReadResult = serde_json::from_value(original.clone()).unwrap();
        assert!(read.cwd.is_none());
        assert!(read.shell_integration.is_none());
        assert!(read.command_events[0].command.is_none());
        assert!(read.command_events[0].is_trusted.is_none());
        assert_eq!(serde_json::to_value(read).unwrap(), original);
        let mut current = original;
        current["cwd"] =
            serde_json::json!({"value": "C:\\work; with spaces", "afterOutputSequence": 4});
        current["commandEvents"][0]["cwd"] = serde_json::json!("C:\\invocation");
        current["cwd"]["isTrusted"] = serde_json::json!(true);
        current["commandEvents"][0]["command"] = serde_json::json!("echo 中文; \"quoted\"\nnext");
        current["commandEvents"][0]["isTrusted"] = serde_json::json!(false);
        current["shellIntegration"] = serde_json::json!({
            "commandDetection": true, "cwdDetection": true, "hasRichCommandDetection": true,
            "commandStorageDisabled": false, "commands": current["commandEvents"], "afterOutputSequence": 4,
        });
        let read: TerminalReadResult = serde_json::from_value(current.clone()).unwrap();
        assert_eq!(serde_json::to_value(read).unwrap(), current);
    }

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
        let request: TerminalEnvironmentReadParams =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(request.names.is_none());
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({})
        );
    }

    #[test]
    fn terminal_profile_resolution_preserves_candidates_and_literal_arguments() {
        let value = serde_json::json!({
            "dirId": "workspace",
            "profile": {"type": "custom", "name": "Custom shell", "path": ["/missing/shell", "/bin/sh"], "args": ["with spaces", "literal;$HOME"]}
        });
        let request: TerminalProfileResolveParams = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), value);
        assert!(serde_json::from_value::<TerminalProfileResolveParams>(serde_json::json!({
            "profile": {"type": "custom", "name": "Custom shell", "path": ["/bin/sh"], "args": [], "execution": {"type": "process"}}
        })).is_err());
    }
}

impl fmt::Debug for TerminalShellIntegrationEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let kind = match self {
            Self::ProcessReady { .. } => "ProcessReady",
            Self::PromptStart => "PromptStart",
            Self::CommandStart => "CommandStart",
            Self::CommandExecuted { .. } => "CommandExecuted",
            Self::CommandFinished { .. } => "CommandFinished",
            Self::CommandLine { .. } => "CommandLine",
            Self::ContinuationStart => "ContinuationStart",
            Self::ContinuationEnd => "ContinuationEnd",
            Self::RightPromptStart => "RightPromptStart",
            Self::RightPromptEnd => "RightPromptEnd",
            Self::Cwd { .. } => "Cwd",
            Self::HasRichCommandDetection { .. } => "HasRichCommandDetection",
            Self::CommandStorageDisabled => "CommandStorageDisabled",
            Self::PromptType { .. } => "PromptType",
            Self::Environment { .. } => "Environment",
            Self::EnvironmentStart { .. } => "EnvironmentStart",
            Self::EnvironmentEntry { .. } => "EnvironmentEntry",
            Self::EnvironmentDelete { .. } => "EnvironmentDelete",
            Self::EnvironmentEnd { .. } => "EnvironmentEnd",
        };
        // Payloads may contain credentials. Transport serialization remains complete.
        formatter.debug_struct(kind).finish_non_exhaustive()
    }
}
