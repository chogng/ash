//! Commands, events, and recovery policy shared by the Session runtime and its worker.

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::mpsc::Receiver;
use std::sync::mpsc::SyncSender;
use std::time::Duration;

use ash_app_server_client::AppServerRequestHandle;
use ash_app_server_client::ServerNotification;
use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
use ash_app_server_protocol::protocol::slash_commands::SlashCommandDefinition;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptSnapshot;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptUpdateEnvelope;
use ash_protocol::ApprovalMode;
use ash_protocol::CommandId;
use ash_protocol::ModelRef;
use ash_protocol::Session;
use ash_protocol::SessionId;
use ash_protocol::Thread;
use ash_protocol::TurnId;

/// The default number of commands that may wait for the worker.
pub const DEFAULT_COMMAND_QUEUE_CAPACITY: usize = 32;

/// Error returned when a command arrives while the worker has no live connection.
pub const SESSION_UNAVAILABLE_COMMAND_ERROR: &str =
    "Session runtime is not connected; the command was not sent";

/// Maximum time spent trying to recover a lost remote connection.
pub const RECONNECT_WINDOW: Duration = Duration::from_secs(30);

const INITIAL_RECONNECT_DELAY: Duration = Duration::from_millis(250);
/// Maximum delay between two remote reconnect attempts.
pub const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(2);

/// The result type used by request/response commands.
pub type CommandResult<T> = std::result::Result<T, String>;

/// The result prepared before the host reconnects with another cwd.
#[derive(Debug)]
pub struct EnvCwdSetResult {
    /// The cwd that the next connection should use.
    pub cwd: PathBuf,
}

/// Events emitted by the Session runtime worker.
pub enum SessionRuntimeEvent {
    /// A ready connection handle for product-owned App Server capabilities.
    Connected(AppServerRequestHandle),
    /// The current connection became unavailable.
    Disconnected,
    /// Catalog data needed by ChatInput.
    Catalog {
        /// Slash commands advertised by the server.
        slash_commands: Vec<SlashCommandDefinition>,
        /// Models advertised by the server.
        models: Vec<ModelCatalogEntry>,
    },
    /// Session list available through the current environment connection.
    SessionCatalog(Vec<Session>),
    /// Authoritative snapshot for the active thread.
    Snapshot {
        /// Session containing the active thread.
        session: Session,
        /// Current thread state.
        thread: Thread,
        /// Backend-assembled transcript for the active thread.
        transcript: ThreadTranscriptSnapshot,
    },
    /// One backend-assembled transcript update from the server.
    TranscriptUpdate(Box<ThreadTranscriptUpdateEnvelope>),
    /// An App Server notification not owned by Session/Thread handling.
    Notification(ServerNotification),
    /// A worker or transport error.
    Error(String),
    /// The worker has stopped and will emit no more events.
    Closed,
}

/// Commands accepted by the Session runtime worker.
pub enum SessionRuntimeCommand {
    /// Create and activate a new Session.
    CreateSession,
    /// Stop a Session and return the server result.
    StopSession {
        /// Session to stop.
        session_id: SessionId,
        /// Completion channel.
        response: SyncSender<CommandResult<()>>,
    },
    /// Archive a Session and return the server result.
    ArchiveSession {
        /// Session to archive.
        session_id: SessionId,
        /// Completion channel.
        response: SyncSender<CommandResult<()>>,
    },
    /// Permanently delete a Session and all of its durable history.
    DeleteSession {
        /// Session to delete.
        session_id: SessionId,
        /// Completion channel.
        response: SyncSender<CommandResult<()>>,
    },
    /// Fork the selected conversation Thread in a Session.
    ForkSession {
        /// Session whose selected conversation should be forked.
        session_id: SessionId,
        /// Completion channel.
        response: SyncSender<CommandResult<()>>,
    },
    /// Subscribe to a Session.
    SubscribeSession {
        /// Session to subscribe to.
        session_id: SessionId,
        /// Completion channel.
        response: SyncSender<CommandResult<()>>,
    },
    /// Submit a text turn to the active Thread.
    SubmitAgentMessage(String),
    /// Rewind before one Turn and submit its replacement with retry-stable command identities.
    RewriteAgentMessage {
        /// Stable identity retained by the caller for every retry of this rewrite.
        operation_id: CommandId,
        /// Source Thread retained across retries even after the runtime activates its child.
        source_thread_id: ash_protocol::ThreadId,
        /// First Turn excluded from the replacement Thread.
        before_turn_id: TurnId,
        /// Replacement user message.
        text: String,
    },
    /// Submit a shell turn to the active Thread.
    SubmitShellCommand(String),
    /// Change the model used by subsequent Turns without an explicit Agent selection.
    SetModel(ModelRef),
    /// Change the approval mode frozen by the next Turn in the active Session.
    SelectNextApprovalMode(ApprovalMode),
    /// Refresh the active Session and Thread snapshot.
    Refresh,
    /// Prepare a connection with another cwd.
    SetEnvCwd {
        /// cwd to use for the next connection.
        cwd: PathBuf,
        /// Completion channel.
        response: SyncSender<CommandResult<EnvCwdSetResult>>,
    },
    /// Ask the worker to stop after draining no further work.
    Shutdown,
}

/// Sender half of the bounded Session runtime command queue.
pub type SessionRuntimeCommandSender = SyncSender<SessionRuntimeCommand>;

/// Receiver half of the bounded Session runtime command queue.
pub type SessionRuntimeCommandReceiver = Receiver<SessionRuntimeCommand>;

/// Creates the standard-sized Session runtime command queue.
pub fn command_channel() -> (SessionRuntimeCommandSender, SessionRuntimeCommandReceiver) {
    command_channel_with_capacity(DEFAULT_COMMAND_QUEUE_CAPACITY)
}

/// Creates a bounded Session runtime command queue for a host or a focused test.
pub fn command_channel_with_capacity(
    capacity: usize,
) -> (SessionRuntimeCommandSender, SessionRuntimeCommandReceiver) {
    mpsc::sync_channel(capacity)
}

/// Returns the exponential-backoff delay for a reconnect attempt.
pub fn reconnect_delay(attempt: usize) -> Duration {
    let multiplier = 1_u32 << (attempt.min(31) as u32);
    (INITIAL_RECONNECT_DELAY * multiplier).min(MAX_RECONNECT_DELAY)
}

/// Returns a reconnect delay only when it fits inside the recovery window.
pub fn reconnect_delay_within_window(elapsed: Duration, attempt: usize) -> Option<Duration> {
    let remaining = RECONNECT_WINDOW.checked_sub(elapsed)?;
    let delay = reconnect_delay(attempt);
    (delay <= remaining).then_some(delay)
}

/// Rejects queued commands while disconnected and completes request/response commands with a
/// stable error. Returns `true` when the worker should stop instead of recovering.
pub fn reject_disconnected_command(command: SessionRuntimeCommand) -> bool {
    match command {
        SessionRuntimeCommand::Shutdown => return true,
        SessionRuntimeCommand::SetEnvCwd { response, .. } => {
            let _ = response.send(disconnected_command_error());
        }
        SessionRuntimeCommand::SubscribeSession { response, .. } => {
            let _ = response.send(disconnected_command_error());
        }
        SessionRuntimeCommand::StopSession { response, .. } => {
            let _ = response.send(disconnected_command_error());
        }
        SessionRuntimeCommand::ArchiveSession { response, .. }
        | SessionRuntimeCommand::DeleteSession { response, .. }
        | SessionRuntimeCommand::ForkSession { response, .. } => {
            let _ = response.send(disconnected_command_error());
        }
        SessionRuntimeCommand::CreateSession
        | SessionRuntimeCommand::SubmitAgentMessage(_)
        | SessionRuntimeCommand::RewriteAgentMessage { .. }
        | SessionRuntimeCommand::SubmitShellCommand(_)
        | SessionRuntimeCommand::SetModel(_)
        | SessionRuntimeCommand::SelectNextApprovalMode(_)
        | SessionRuntimeCommand::Refresh => {}
    }
    false
}

fn disconnected_command_error<T>() -> CommandResult<T> {
    Err(SESSION_UNAVAILABLE_COMMAND_ERROR.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_queue_is_bounded() {
        let (sender, receiver) = command_channel_with_capacity(1);
        sender.send(SessionRuntimeCommand::Refresh).unwrap();

        assert!(sender.try_send(SessionRuntimeCommand::Refresh).is_err());
        assert!(matches!(
            receiver.recv().unwrap(),
            SessionRuntimeCommand::Refresh
        ));
    }

    #[test]
    fn remote_reconnect_backoff_is_bounded() {
        assert_eq!(reconnect_delay(0), Duration::from_millis(250));
        assert_eq!(reconnect_delay(1), Duration::from_millis(500));
        assert_eq!(reconnect_delay(3), Duration::from_secs(2));
        assert_eq!(reconnect_delay(32), MAX_RECONNECT_DELAY);
    }

    #[test]
    fn remote_reconnect_never_schedules_past_its_recovery_window() {
        assert_eq!(
            reconnect_delay_within_window(Duration::ZERO, 0),
            Some(Duration::from_millis(250))
        );
        assert_eq!(
            reconnect_delay_within_window(RECONNECT_WINDOW - Duration::from_secs(2), 8),
            Some(Duration::from_secs(2))
        );
        assert_eq!(
            reconnect_delay_within_window(RECONNECT_WINDOW - Duration::from_millis(100), 0),
            None
        );
        assert_eq!(reconnect_delay_within_window(RECONNECT_WINDOW, 0), None);
    }

    #[test]
    fn disconnected_request_is_completed_without_replay() {
        let (response, result) = mpsc::sync_channel(1);
        assert!(!reject_disconnected_command(
            SessionRuntimeCommand::StopSession {
                session_id: SessionId::new("session").unwrap(),
                response,
            }
        ));
        assert_eq!(
            result.recv().unwrap(),
            Err(SESSION_UNAVAILABLE_COMMAND_ERROR.to_owned())
        );
        assert!(reject_disconnected_command(SessionRuntimeCommand::Shutdown));
    }
}
