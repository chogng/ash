use serde::Deserialize;
use serde::Serialize;
use std::fmt;

/// Literal argv, or a pre-escaped Windows command-line tail kept intact until ConPTY.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
#[serde(untagged)]
pub enum TerminalArguments {
    Argv(Vec<String>),
    CommandLine(String),
}

/// One server-owned shell profile available to interactive terminal clients.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct TerminalProfile {
    pub profile_id: String,
    pub title: String,
    pub is_default: bool,
}

/// Selects either the server default or one previously listed authorized profile.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub enum TerminalProfileSelection {
    Default,
    Profile {
        profile_id: String,
    },
    Custom {
        name: String,
        path: Vec<String>,
        args: TerminalArguments,
    },
}

/// Validated executable and argument representation selected on the execution host.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct TerminalResolvedProfile {
    pub profile: TerminalProfile,
    pub executable: String,
    pub args: TerminalArguments,
}

/// Selects whether a terminal dies with its creating connection or may be reattached briefly.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalLifecycle {
    ConnectionOwned,
    Reconnectable,
}

/// Executes a program with literal arguments or a command through the selected shell.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub enum TerminalExecution {
    Process {
        program: String,
        args: TerminalArguments,
    },
    Shell {
        command_line: String,
    },
}

/// Starts one interactive terminal at the server's authorized directory.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct TerminalCreateRequest {
    pub rows: u16,
    pub cols: u16,
    pub profile: TerminalProfileSelection,
    pub lifecycle: TerminalLifecycle,
    #[serde(default)]
    pub env: Option<std::collections::HashMap<String, Option<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strict_env: Option<bool>,
    #[serde(default)]
    pub cwd: Option<std::path::PathBuf>,
    #[serde(default)]
    pub execution: Option<TerminalExecution>,
}

/// One short-lived bearer lease used to reattach a detached terminal.
#[derive(Serialize, Deserialize, Clone, Eq, PartialEq)]
pub struct TerminalReconnectLease {
    pub reconnect_token: String,
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

/// Spawn-confirmed OS identity and the directory actually passed to the shell.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct TerminalProcessReady {
    pub pid: u32,
    pub cwd: String,
}

/// Current backend-owned process properties; shell cwd is retained after exit when detected.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct TerminalProcessInfo {
    pub ready: TerminalProcessReady,
    pub cwd: Option<String>,
    pub rows: u16,
    pub cols: u16,
    pub has_child_processes: Option<bool>,
}

/// Sends the supported process-control signal rather than encoding it as terminal input.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalSignal {
    Interrupt,
}

/// Identity allocated for one interactive terminal.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct TerminalCreateResult {
    pub ready: TerminalProcessReady,
    pub terminal_id: String,
    pub profile: TerminalProfile,
    pub reconnect: Option<TerminalReconnectLease>,
}

/// Reclaims one reconnectable terminal after its previous connection closed.
#[derive(Serialize, Deserialize, Clone, Eq, PartialEq)]
pub struct TerminalAttachRequest {
    pub terminal_id: String,
    pub reconnect_token: String,
    pub rows: u16,
    pub cols: u16,
}

impl fmt::Debug for TerminalAttachRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TerminalAttachRequest")
            .field("terminal_id", &self.terminal_id)
            .field("reconnect_token", &"[REDACTED]")
            .field("rows", &self.rows)
            .field("cols", &self.cols)
            .finish()
    }
}

/// Confirms attachment and rotates the bearer token for the next disconnect.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct TerminalAttachResult {
    pub ready: TerminalProcessReady,
    pub terminal_id: String,
    pub reconnect: TerminalReconnectLease,
}

/// Writes one bounded UTF-8 input batch to an interactive terminal.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct TerminalWriteRequest {
    pub terminal_id: String,
    pub data: String,
}

/// Writes one bounded raw input batch without UTF-8 encoding or command inference.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct TerminalWriteBinaryRequest {
    pub terminal_id: String,
    pub data: Vec<u8>,
}

/// Changes the PTY character-cell dimensions.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct TerminalResizeRequest {
    pub terminal_id: String,
    pub rows: u16,
    pub cols: u16,
}

/// Reads output after the last sequence observed by this client.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct TerminalReadRequest {
    pub terminal_id: String,
    pub after_sequence: u64,
    pub after_command_sequence: u64,
    pub max_chunks: usize,
}

/// Shells with an integrated display protocol, selected by the execution host.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TerminalShellType {
    Bash,
    Zsh,
    #[serde(rename = "pwsh")]
    PowerShell,
}

/// Shell display boundaries verified and decoded by the PTY owner, in output order.
#[derive(Serialize, Deserialize, Clone, Eq, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TerminalShellIntegrationEvent {
    ProcessReady {
        is_windows_pty: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
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
        timestamp_millis: u64,
    },
    CommandFinished {
        exit_code: Option<i32>,
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

/// One ordered raw PTY output chunk.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct TerminalOutputChunk {
    pub sequence: u64,
    pub data: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_integration: Option<TerminalShellIntegrationEvent>,
}

/// Renderer-independent lifecycle state for one shell command.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalCommandStatus {
    Running,
    Completed,
    Succeeded,
    Failed,
    Canceled,
}

/// Last shell-reported directory, ordered against the retained output stream.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct TerminalCwd {
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_trusted: Option<bool>,
    pub after_output_sequence: u64,
}

/// One ordered command lifecycle transition associated with PTY output.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct TerminalCommandStatusEvent {
    pub sequence: u64,
    pub command_id: String,
    pub status: TerminalCommandStatus,
    pub exit_code: Option<i32>,
    pub after_output_sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// Only command-text provenance; this grants no execution or path authority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_trusted: Option<bool>,
}

/// Detected protocol support and bounded completed commands owned by this PTY.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct TerminalShellIntegration {
    pub command_detection: bool,
    pub cwd_detection: bool,
    pub has_rich_command_detection: bool,
    pub command_storage_disabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_type: Option<String>,
    pub commands: Vec<TerminalCommandStatusEvent>,
    pub after_output_sequence: u64,
}

/// Bounded output and process state for one interactive terminal.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct TerminalReadResult {
    pub terminal_id: String,
    pub chunks: Vec<TerminalOutputChunk>,
    pub next_sequence: u64,
    pub output_gap: bool,
    pub command_events: Vec<TerminalCommandStatusEvent>,
    pub next_command_sequence: u64,
    pub command_event_gap: bool,
    pub exited: bool,
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<TerminalCwd>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_integration: Option<TerminalShellIntegration>,
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
