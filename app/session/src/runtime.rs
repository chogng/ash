//! App Server runtime for the Session capability.
//!
//! This module owns the Session/Thread requests, subscription, command queue, and reconnect
//! lifecycle. Other App Server capabilities use the connected request handle emitted to the
//! product host.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::sync::mpsc::SyncSender;
use std::thread;
use std::thread::JoinHandle;

use anyhow::Context;
use anyhow::Result;
use anyhow::anyhow;
use ash_protocol::ApprovalMode;
use ash_protocol::CommandId;
use ash_protocol::ModelRef;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;

mod contract;
mod worker;

pub use contract::CommandResult;
pub use contract::EnvCwdSetResult;
pub(crate) use contract::RECONNECT_WINDOW;
pub use contract::SESSION_UNAVAILABLE_COMMAND_ERROR;
pub(crate) use contract::SessionRuntimeCommand;
pub use contract::SessionRuntimeEvent;
use contract::command_channel;
pub(crate) use contract::reconnect_delay_within_window;
pub(crate) use contract::reject_disconnected_command;

/// Connection authority supplied by the product host.
///
/// Implementations preserve their Local or Remote transport identity when selecting another cwd.
/// The runtime uses this contract without importing product composition types.
pub trait SessionRuntimeTarget: Send + Sync {
    /// Returns whether transport loss should use the bounded reconnect policy.
    fn is_remote(&self) -> bool;

    /// Returns the cwd represented by this target.
    fn cwd(&self) -> &Path;

    /// Creates the same connection authority with another cwd.
    fn with_cwd(&self, cwd: &Path) -> CommandResult<Box<dyn SessionRuntimeTarget>>;

    /// Opens and initializes one App Server protocol session.
    fn start(&self) -> CommandResult<ash_app_server_client::AppServerSession>;
}

pub(crate) type SessionRuntimeEventSink =
    Arc<dyn Fn(SessionRuntimeEvent) -> CommandResult<()> + Send + Sync>;
/// Running Session runtime worker handle used by the product host.
pub struct SessionRuntime {
    available: Arc<AtomicBool>,
    commands: SyncSender<SessionRuntimeCommand>,
    worker: Option<JoinHandle<()>>,
}

impl SessionRuntime {
    /// Starts one worker for the supplied App Server target and product event sink.
    pub fn spawn<T, F>(target: T, event_sink: F) -> Result<Self>
    where
        T: SessionRuntimeTarget + 'static,
        F: Fn(SessionRuntimeEvent) -> CommandResult<()> + Send + Sync + 'static,
    {
        let (commands, command_receiver) = command_channel();
        let available = Arc::new(AtomicBool::new(false));
        let worker_availability = Arc::clone(&available);
        let event_sink: SessionRuntimeEventSink = Arc::new(event_sink);
        let worker = thread::Builder::new()
            .name("app-session-runtime".into())
            .spawn(move || {
                worker::run_session_runtime(
                    event_sink,
                    command_receiver,
                    Box::new(target),
                    worker_availability,
                )
            })
            .context("could not start Session runtime worker")?;
        Ok(Self {
            available,
            commands,
            worker: Some(worker),
        })
    }

    /// Returns whether the worker currently accepts commands.
    pub fn is_available(&self) -> bool {
        self.available.load(Ordering::Acquire)
    }

    /// Submits one text turn to the active Thread.
    pub fn submit_agent_message(&self, text: String) -> Result<()> {
        self.try_send(
            SessionRuntimeCommand::SubmitAgentMessage(text),
            "Session submission queue is unavailable",
        )
    }

    /// Rewinds before one historical Turn and submits a replacement user message.
    ///
    /// Callers retain and reuse `operation_id` for retries. The shared App Server derives the
    /// rewind and start-Turn command IDs, so every product client gets the same idempotency rules.
    pub fn rewrite_agent_message(
        &self,
        operation_id: CommandId,
        source_thread_id: ThreadId,
        before_turn_id: TurnId,
        text: String,
    ) -> Result<()> {
        self.try_send(
            SessionRuntimeCommand::RewriteAgentMessage {
                operation_id,
                source_thread_id,
                before_turn_id,
                text,
            },
            "Session rewrite queue is unavailable",
        )
    }

    /// Creates and activates a Session.
    pub fn create_session(&self) -> Result<()> {
        self.try_send(
            SessionRuntimeCommand::CreateSession,
            "Session creation queue is unavailable",
        )
    }

    /// Stops an active Session.
    pub fn stop_session(&self, session_id: SessionId) -> Result<()> {
        let (response, result) = mpsc::sync_channel(1);
        self.try_send(
            SessionRuntimeCommand::StopSession {
                session_id,
                response,
            },
            "Session stop queue is unavailable",
        )?;
        result
            .recv()
            .context("Session stop worker stopped")?
            .map_err(anyhow::Error::msg)
    }

    /// Archives a Session.
    pub fn archive_session(&self, session_id: SessionId) -> Result<()> {
        let (response, result) = mpsc::sync_channel(1);
        self.try_send(
            SessionRuntimeCommand::ArchiveSession {
                session_id,
                response,
            },
            "Session archive queue is unavailable",
        )?;
        result
            .recv()
            .context("Session archive worker stopped")?
            .map_err(anyhow::Error::msg)
    }

    /// Permanently deletes a Session and all of its durable history.
    pub fn delete_session(&self, session_id: SessionId) -> Result<()> {
        let (response, result) = mpsc::sync_channel(1);
        self.try_send(
            SessionRuntimeCommand::DeleteSession {
                session_id,
                response,
            },
            "Session delete queue is unavailable",
        )?;
        result
            .recv()
            .context("Session delete worker stopped")?
            .map_err(anyhow::Error::msg)
    }

    /// Forks the selected conversation in a Session.
    pub fn fork_session(&self, session_id: SessionId) -> Result<()> {
        let (response, result) = mpsc::sync_channel(1);
        self.try_send(
            SessionRuntimeCommand::ForkSession {
                session_id,
                response,
            },
            "Session fork queue is unavailable",
        )?;
        result
            .recv()
            .context("Session fork worker stopped")?
            .map_err(anyhow::Error::msg)
    }

    /// Subscribes to a Session.
    pub fn subscribe_session(&self, session_id: SessionId) -> Result<()> {
        let (response, result) = mpsc::sync_channel(1);
        self.try_send(
            SessionRuntimeCommand::SubscribeSession {
                session_id,
                response,
            },
            "Session subscription queue is unavailable",
        )?;
        result
            .recv()
            .context("Session subscription worker stopped")?
            .map_err(anyhow::Error::msg)
    }

    /// Submits one shell turn to the active Thread.
    pub fn submit_shell_command(&self, command: String) -> Result<()> {
        self.try_send(
            SessionRuntimeCommand::SubmitShellCommand(command),
            "Shell submission queue is unavailable",
        )
    }

    /// Sets the model used by subsequent Turns without an explicit Agent selection.
    pub fn set_model(&self, model: ModelRef) -> Result<()> {
        self.try_send(
            SessionRuntimeCommand::SetModel(model),
            "Model selection queue is unavailable",
        )
    }

    /// Selects the approval mode used by the next Turn in the active Session.
    pub fn select_next_approval_mode(&self, approval_mode: ApprovalMode) -> Result<()> {
        self.try_send(
            SessionRuntimeCommand::SelectNextApprovalMode(approval_mode),
            "Session approval mode selection queue is unavailable",
        )
    }

    /// Refreshes the active Session subscription.
    pub fn refresh(&self) -> Result<()> {
        self.try_send(
            SessionRuntimeCommand::Refresh,
            "Session refresh queue is unavailable",
        )
    }

    /// Prepares and switches the worker to another cwd.
    pub fn set_env_cwd(&self, cwd: PathBuf) -> Result<EnvCwdSetResult> {
        let (response, result) = mpsc::sync_channel(1);
        self.try_send(
            SessionRuntimeCommand::SetEnvCwd { cwd, response },
            "cwd change queue is unavailable",
        )?;
        result
            .recv()
            .context("cwd change worker stopped")?
            .map_err(anyhow::Error::msg)
    }

    fn try_send(&self, command: SessionRuntimeCommand, queue_error: &'static str) -> Result<()> {
        if !self.is_available() {
            return Err(anyhow!(SESSION_UNAVAILABLE_COMMAND_ERROR));
        }
        self.commands.try_send(command).context(queue_error)
    }
}

impl Drop for SessionRuntime {
    fn drop(&mut self) {
        self.available.store(false, Ordering::Release);
        let _ = self.commands.send(SessionRuntimeCommand::Shutdown);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
