use serde::Deserialize;
use serde::Serialize;
use std::fmt;

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
    Profile { profile_id: String },
}

/// Selects whether a terminal dies with its creating connection or may be reattached briefly.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalLifecycle {
    ConnectionOwned,
    Reconnectable,
}

/// Starts one interactive terminal at the server's authorized directory.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct TerminalCreateRequest {
    pub rows: u16,
    pub cols: u16,
    pub profile: TerminalProfileSelection,
    pub lifecycle: TerminalLifecycle,
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

/// Identity allocated for one interactive terminal.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct TerminalCreateResult {
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
    pub terminal_id: String,
    pub reconnect: TerminalReconnectLease,
}

/// Writes one bounded UTF-8 input batch to an interactive terminal.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct TerminalWriteRequest {
    pub terminal_id: String,
    pub data: String,
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

/// One ordered raw PTY output chunk.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct TerminalOutputChunk {
    pub sequence: u64,
    pub data: Vec<u8>,
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

/// One ordered command lifecycle transition associated with PTY output.
#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct TerminalCommandStatusEvent {
    pub sequence: u64,
    pub command_id: String,
    pub status: TerminalCommandStatus,
    pub exit_code: Option<i32>,
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
}
