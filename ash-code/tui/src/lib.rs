//! Interactive terminal client for Ash's App Server product boundary.

mod app;
mod client;
mod config;
mod connectors;
mod dirs;
mod git;
mod host;
mod issues;
mod keymap;
mod keymap_setup;
mod mcp;
mod memories;
mod memory;
mod models;
mod nls;
mod projects;
mod render;
mod sessions;
mod skills;
mod status;
mod terminal;
#[cfg(test)]
mod test_support;
#[cfg(test)]
// Keep the owning Rust module in each filename while omitting the crate name from TUI baselines.
#[macro_export]
macro_rules! tui_assert_snapshot {
    ($value:expr, @$snapshot:literal $(,)?) => {{
        ::insta::assert_snapshot!($value, @$snapshot)
    }};
    ($name:expr, $value:expr, $debug_expr:expr $(,)?) => {{
        let mut settings = ::insta::Settings::clone_current();
        settings.set_prepend_module_to_snapshot(false);
        let snapshot_name = $crate::test_support::snapshot_name($name, module_path!());
        settings.bind(|| {
            ::insta::assert_snapshot!(snapshot_name, $value, $debug_expr)
        });
    }};
    ($name:expr, $value:expr $(,)?) => {{
        let mut settings = ::insta::Settings::clone_current();
        settings.set_prepend_module_to_snapshot(false);
        let snapshot_name = $crate::test_support::snapshot_name($name, module_path!());
        settings.bind(|| ::insta::assert_snapshot!(snapshot_name, $value));
    }};
    ($value:expr $(,)?) => {{
        let mut settings = ::insta::Settings::clone_current();
        settings.set_prepend_module_to_snapshot(false);
        let snapshot_name = $crate::test_support::snapshot_name_for_function(
            ::insta::_function_name!(),
            module_path!(),
        );
        settings.bind(|| ::insta::assert_snapshot!(snapshot_name, $value));
    }};
}

mod theme;
mod thread;
mod widgets;

use ash_app_server_client::AppServerSession;
use ash_app_server_client::ClientError;
use ash_app_server_client::ShutdownError;
use ash_app_server_client::TakeEventsError;
use ash_app_server_protocol::protocol::common::AgentInteractionCapability;
use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::common::DirPermissionsHostCapability;
use ash_protocol::AgentInteractionKind;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;

pub use ash_product_update::UpdatePolicy;

/// Declares the connection-local App Server capabilities required by the TUI.
///
/// The CLI host passes this value during `initialize` so App Server can select this connection as
/// the ephemeral owner for approval and structured user-input requests on subscribed Threads, and
/// accept explicit `/add-dir` consent as a session-scoped directory capability decision.
pub fn client_capabilities() -> ClientCapabilities {
    ClientCapabilities {
        notifications: Some(true),
        agent_interactions: Some(AgentInteractionCapability {
            version: 1,
            kinds: vec![
                AgentInteractionKind::Approval,
                AgentInteractionKind::UserInput,
            ],
            dynamic_tools: None,
        }),
        browser: None,
        dir_permissions_host: Some(DirPermissionsHostCapability { version: 1 }),
    }
}

/// Reads the profile-wide automatic-update preference owned by the terminal product.
///
/// The CLI host uses this narrow view of `[tui]` so the setting has one decoder and one default.
pub fn update_policy(
    section: &ash_app_server_protocol::protocol::config::FrontendConfigDto,
) -> Result<UpdatePolicy, String> {
    config::TerminalSettings::from_tui(section).map(config::TerminalSettings::auto_update)
}

/// Cloneable receiver for short notices emitted by the local CLI host.
#[derive(Clone)]
pub struct TuiNotices {
    receiver: Arc<Mutex<mpsc::Receiver<String>>>,
}

impl fmt::Debug for TuiNotices {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TuiNotices")
    }
}

impl PartialEq for TuiNotices {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.receiver, &other.receiver)
    }
}

impl Eq for TuiNotices {}

impl TuiNotices {
    /// Wraps the receiving half of a host-owned notice channel.
    pub fn new(receiver: mpsc::Receiver<String>) -> Self {
        Self {
            receiver: Arc::new(Mutex::new(receiver)),
        }
    }

    pub(crate) fn try_recv(&self) -> Result<String, mpsc::TryRecvError> {
        self.receiver.lock().unwrap().try_recv()
    }
}

/// Startup values owned by the CLI host rather than by the terminal UI.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TuiOptions {
    thread_title: String,
    display_dir_root: PathBuf,
    host_dir_root: PathBuf,
    host_file_search_root: Option<PathBuf>,
    profile_root: Option<PathBuf>,
    theme_root: Option<PathBuf>,
    connection: TuiConnectionKind,
    app_server_process: AppServerProcess,
    recovery: Option<TuiRecoveryState>,
    drafts: Option<TuiRecoveryDrafts>,
    notices: Option<TuiNotices>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TuiConnectionKind {
    Local,
    Remote,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AppServerProcess {
    IncludedInTui,
    Local(u32),
    Remote,
}

impl TuiConnectionKind {
    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::Local => "Local App Server",
            Self::Remote => "Remote App Server",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TuiStartupContext {
    pub(crate) workspace: PathBuf,
    pub(crate) profile_root: Option<PathBuf>,
    pub(crate) connection: TuiConnectionKind,
    pub(crate) app_server_process: AppServerProcess,
    pub(crate) recovery: Option<TuiRecoveryState>,
}

impl TuiStartupContext {
    #[cfg(test)]
    pub(crate) fn new(workspace: impl Into<PathBuf>) -> Self {
        Self {
            workspace: workspace.into(),
            profile_root: None,
            connection: TuiConnectionKind::Local,
            app_server_process: AppServerProcess::IncludedInTui,
            recovery: None,
        }
    }
}

impl TuiOptions {
    pub fn new(thread_title: impl Into<String>) -> Self {
        let dir_root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        Self {
            thread_title: thread_title.into(),
            display_dir_root: dir_root.clone(),
            host_dir_root: dir_root.clone(),
            host_file_search_root: Some(dir_root),
            profile_root: None,
            theme_root: None,
            connection: TuiConnectionKind::Local,
            app_server_process: AppServerProcess::IncludedInTui,
            recovery: None,
            drafts: None,
            notices: None,
        }
    }

    /// Uses `dir_root` for display and bounded local host file operations.
    pub fn with_dir_root(mut self, dir_root: impl Into<PathBuf>) -> Self {
        let dir_root = dir_root.into();
        self.display_dir_root = dir_root.clone();
        self.host_dir_root = dir_root.clone();
        self.host_file_search_root = Some(dir_root);
        self.connection = TuiConnectionKind::Local;
        self.app_server_process = AppServerProcess::IncludedInTui;
        self
    }

    /// Displays a Remote directory without scanning it through the local host filesystem.
    ///
    /// Host-only output such as transcript export remains bounded to the local directory root
    /// configured before this method is called. Remote path completion can be added later through
    /// an App Server-owned path-search contract.
    pub fn with_remote_dir(mut self, remote_dir_root: impl Into<PathBuf>) -> Self {
        self.display_dir_root = remote_dir_root.into();
        self.host_file_search_root = None;
        self.connection = TuiConnectionKind::Remote;
        self.app_server_process = AppServerProcess::Remote;
        self
    }

    /// Includes the locally owned App Server child in process resource monitoring.
    pub fn with_app_server_process_id(mut self, process_id: u32) -> Self {
        self.connection = TuiConnectionKind::Local;
        self.app_server_process = AppServerProcess::Local(process_id);
        self
    }

    /// Enables Ash Code theme documents from the active profile.
    pub fn with_profile_root(mut self, profile_root: impl Into<PathBuf>) -> Self {
        let profile_root = profile_root.into();
        let product_root = profile_root.join("ash-code");
        self.profile_root = Some(profile_root);
        self.theme_root = Some(product_root);
        self
    }

    /// Restores the durable Session and Thread selected before a transport loss.
    pub fn with_recovery(mut self, recovery: TuiRecoveryState) -> Self {
        self.recovery = Some(recovery);
        self
    }

    /// Restores unsent editor drafts after a transport reconnect.
    pub fn with_drafts(mut self, drafts: TuiRecoveryDrafts) -> Self {
        self.drafts = Some(drafts);
        self
    }

    /// Delivers short local-host notices into the normal TUI notice row.
    pub fn with_notices(mut self, notices: TuiNotices) -> Self {
        self.notices = Some(notices);
        self
    }

    pub(crate) fn startup_context(&self) -> TuiStartupContext {
        TuiStartupContext {
            workspace: self.display_dir_root.clone(),
            profile_root: self.profile_root.clone(),
            connection: self.connection,
            app_server_process: self.app_server_process,
            recovery: self.recovery.clone(),
        }
    }
}

/// Durable product identity returned to the CLI host after an App Server transport loss.
///
/// The state contains no transport handle, credential, pending request, or local command queue.
/// A host may establish a new connection and pass this state back through
/// [`TuiOptions::with_recovery`] to reload the canonical Thread snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TuiRecoveryState {
    session_id: SessionId,
    thread_id: ThreadId,
}

/// Unsent editor state returned to the CLI host when the transport disconnects.
#[derive(Clone, Default, Eq, PartialEq)]
pub struct TuiRecoveryDrafts {
    pub(crate) new_session: Option<crate::thread::composer::ChatInputDraft>,
    pub(crate) threads: BTreeMap<ThreadId, crate::thread::composer::ChatInputDraft>,
    pub(crate) home_visible: bool,
}

impl fmt::Debug for TuiRecoveryDrafts {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TuiRecoveryDrafts")
            .field("new_session", &self.new_session.is_some())
            .field("threads", &self.threads.len())
            .field("home_visible", &self.home_visible)
            .finish()
    }
}

/// Classifies why an initialized TUI connection reached its terminal boundary.
///
/// Product hosts may retry [`Self::Transport`] after establishing a new connection. A server
/// shutdown or protocol failure is terminal and must not be converted into a transport retry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TuiConnectionLossKind {
    /// The App Server transport stopped without a local shutdown request.
    Transport,
    /// The App Server session reported an orderly shutdown.
    ServerShutdown,
    /// The App Server stream violated the initialized protocol.
    Protocol,
}

impl TuiRecoveryState {
    /// Selects the durable Session and Thread that a new TUI connection must reload.
    pub fn new(session_id: SessionId, thread_id: ThreadId) -> Self {
        Self {
            session_id,
            thread_id,
        }
    }

    /// Returns the durable Session selected when the connection was lost.
    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    /// Returns the preferred durable Thread selected when the connection was lost.
    pub fn thread_id(&self) -> &ThreadId {
        &self.thread_id
    }

    pub(crate) fn into_parts(self) -> (SessionId, ThreadId) {
        (self.session_id, self.thread_id)
    }
}

/// Describes why the interactive terminal returned control to its host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TuiExit {
    /// The user exited through an interactive TUI command or key binding.
    UserRequested,
    /// The host process received an operating-system termination request.
    TerminationRequested,
    /// The initialized App Server connection ended; a home page may have no durable conversation.
    ConnectionLost {
        kind: TuiConnectionLossKind,
        recovery: Option<TuiRecoveryState>,
        drafts: TuiRecoveryDrafts,
        reason: String,
    },
}

/// Failure to start or operate an interactive terminal session.
#[derive(Debug)]
pub enum TuiError {
    Client(ClientError),
    EventStream(TakeEventsError),
    Shutdown(ShutdownError),
    Terminal(std::io::Error),
}

impl fmt::Display for TuiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Client(error) => write!(formatter, "{error}"),
            Self::EventStream(error) => write!(formatter, "{error}"),
            Self::Shutdown(error) => write!(formatter, "{error}"),
            Self::Terminal(error) => write!(formatter, "terminal error: {error}"),
        }
    }
}

impl std::error::Error for TuiError {}

impl From<ClientError> for TuiError {
    fn from(error: ClientError) -> Self {
        Self::Client(error)
    }
}

impl From<std::io::Error> for TuiError {
    fn from(error: std::io::Error) -> Self {
        Self::Terminal(error)
    }
}

impl From<TakeEventsError> for TuiError {
    fn from(error: TakeEventsError) -> Self {
        Self::EventStream(error)
    }
}

impl From<ShutdownError> for TuiError {
    fn from(error: ShutdownError) -> Self {
        Self::Shutdown(error)
    }
}

/// Runs one interactive terminal session over an initialized App Server session.
///
/// The UI subscribes to the active product Thread and resynchronizes from canonical snapshots.
/// App Server notifications and terminal input independently wake the single-writer event loop.
/// A connection loss returns [`TuiExit::ConnectionLost`] without replaying pending or queued
/// commands, allowing the CLI host to reconnect and provide the durable recovery identity to a
/// later invocation. Other exits explicitly shut down the session before returning.
pub fn run(session: AppServerSession, options: TuiOptions) -> Result<TuiExit, TuiError> {
    app::run(session, options)
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
