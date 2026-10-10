use std::fmt;
use std::num::NonZeroU16;
use std::path::PathBuf;
use std::process::Command;

use ash_app_server_client::AppServerSession;
use ash_app_server_client::ClientError;
use ash_app_server_client::StdioAppServerCommand;
use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_app_server_protocol::protocol::initialize::InitializeResult;
use ash_remote::RemoteProfile;
use ash_remote::RemoteRuntime;
pub use ash_remote::remote_app_server_command;

const DEFAULT_CONNECT_TIMEOUT_SECONDS: NonZeroU16 = NonZeroU16::new(10).expect("non-zero");
const RUNTIME_FOUND_MARKER: &str = "__ASH_REMOTE_RUNTIME_FOUND__:";
const RUNTIME_MISSING_MARKER: &str = "__ASH_REMOTE_RUNTIME_MISSING__";

/// Product-selected SSH launch inputs for one Remote App Server session.
///
/// The caller owns this object and invokes [`Self::connect`] from its native host process. The
/// OpenSSH client inherits that host's SSH agent, config, and credential policy; these values do
/// not accept passwords or private keys.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SshAppServerConnectionOptions {
    profile: RemoteProfile,
    ssh_executable: PathBuf,
    connect_timeout_seconds: NonZeroU16,
}

impl SshAppServerConnectionOptions {
    /// Creates options that use the platform `ssh` command and a ten-second connection timeout.
    pub fn new(profile: RemoteProfile) -> Self {
        Self {
            profile,
            ssh_executable: PathBuf::from("ssh"),
            connect_timeout_seconds: DEFAULT_CONNECT_TIMEOUT_SECONDS,
        }
    }

    /// Selects the OpenSSH executable controlled by the product host.
    pub fn with_ssh_executable(mut self, executable: impl Into<PathBuf>) -> Self {
        self.ssh_executable = executable.into();
        self
    }

    /// Selects the OpenSSH TCP connection timeout in whole seconds.
    pub fn with_connect_timeout_seconds(mut self, timeout: NonZeroU16) -> Self {
        self.connect_timeout_seconds = timeout;
        self
    }

    /// Returns the profile whose target this connection reaches.
    pub const fn profile(&self) -> &RemoteProfile {
        &self.profile
    }

    /// Returns the local OpenSSH executable selected by the product host.
    pub fn ssh_executable(&self) -> &std::path::Path {
        &self.ssh_executable
    }

    /// Builds the child command that owns the local SSH transport.
    pub fn stdio_command(&self) -> StdioAppServerCommand {
        let target = self.profile.target();
        StdioAppServerCommand::new(&self.ssh_executable)
            .with_argument("-T")
            .with_argument("-o")
            .with_argument("BatchMode=yes")
            .with_argument("-o")
            .with_argument(format!(
                "ConnectTimeout={}",
                self.connect_timeout_seconds.get()
            ))
            .with_argument(target.host().as_str())
            .with_argument(remote_app_server_command(&self.profile))
    }

    /// Probes whether the selected runtime is executable on the Remote host.
    ///
    /// This is deliberately a separate host-owned SSH command from [`Self::connect`]. A Remote
    /// coordinator can use it before offering installation or upgrade, while a normal connection
    /// still performs the authoritative App Server initialize/schema handshake. The probe never
    /// downloads anything and never receives SSH credentials from the caller.
    pub fn probe_runtime(&self) -> Result<RemoteRuntimeProbe, RemoteConnectionError> {
        let output = Command::new(&self.ssh_executable)
            .args([
                "-T".to_owned(),
                "-o".to_owned(),
                "BatchMode=yes".to_owned(),
                "-o".to_owned(),
                format!("ConnectTimeout={}", self.connect_timeout_seconds),
                self.profile.target().host().as_str().to_owned(),
                remote_runtime_probe_command(self.profile.runtime().executable()),
            ])
            .output()
            .map_err(|error| RemoteConnectionError::transport(error.to_string()))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        match parse_runtime_probe_output(&stdout) {
            Some(RuntimeProbeOutput::Found(resolved_executable)) => {
                let resolved_runtime = RemoteRuntime::new_exact_executable(resolved_executable)
                    .map_err(|_| {
                        RemoteConnectionError::transport(
                            "Remote runtime probe returned a non-canonical executable path",
                        )
                    })?;
                return Ok(RemoteRuntimeProbe {
                    requested_runtime: self.profile.runtime().clone(),
                    resolved_runtime,
                });
            }
            Some(RuntimeProbeOutput::Missing) => {
                return Err(RemoteConnectionError::runtime_unavailable(format!(
                    "Remote runtime `{}` is not executable or is not on the remote PATH",
                    self.profile.runtime().executable()
                )));
            }
            None => {}
        }
        let diagnostic = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let message = if diagnostic.is_empty() {
            format!(
                "Remote runtime probe did not complete successfully (exit status {})",
                output.status
            )
        } else {
            format!(
                "Remote runtime probe did not complete successfully (exit status {}): {}",
                output.status, diagnostic
            )
        };
        Err(RemoteConnectionError::transport(message))
    }

    /// Starts OpenSSH and returns a ready, schema-checked remote App Server session.
    pub fn connect(
        &self,
        client_info: ClientInfo,
        capabilities: ClientCapabilities,
    ) -> Result<AppServerSession, RemoteConnectionError> {
        AppServerSession::start_stdio(self.stdio_command(), client_info, capabilities)
            .map_err(RemoteConnectionError::from_client_error)
    }

    /// Starts one short-lived App Server, performs initialize/schema negotiation, then closes it.
    ///
    /// This is stronger than [`Self::probe_runtime`]: success proves that the selected executable
    /// speaks the current typed protocol. It performs no Session, Thread, filesystem, or terminal
    /// operation and is intended for host-owned install/upgrade decisions before a product UI
    /// starts.
    pub fn probe_compatibility(
        &self,
        client_info: ClientInfo,
        capabilities: ClientCapabilities,
    ) -> Result<InitializeResult, RemoteConnectionError> {
        let session = self.connect(client_info, capabilities)?;
        let client = session.client();
        let initialization = client.initialization().cloned();
        drop(client);
        let shutdown = session
            .shutdown()
            .map_err(|error| RemoteConnectionError::transport(error.to_string()));
        let initialization = initialization.map_err(RemoteConnectionError::from_client_error)?;
        shutdown?;
        Ok(initialization)
    }
}

/// Builds a shell command that reports runtime availability without starting the runtime.
pub(crate) fn remote_runtime_probe_command(executable: &str) -> String {
    let executable = quote_posix_shell_argument(executable);
    let found_marker = quote_posix_shell_argument(RUNTIME_FOUND_MARKER);
    let missing_marker = quote_posix_shell_argument(RUNTIME_MISSING_MARKER);
    format!(
        "if command -v {executable} >/dev/null 2>&1; then printf '%s%s\\n' {found_marker} \"$(command -v {executable})\"; else printf '%s\\n' {missing_marker}; exit 127; fi"
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RuntimeProbeOutput {
    Found(String),
    Missing,
}

pub(crate) fn parse_runtime_probe_output(stdout: &str) -> Option<RuntimeProbeOutput> {
    if let Some(resolved_executable) = stdout.lines().find_map(|line| {
        line.strip_prefix(RUNTIME_FOUND_MARKER)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }) {
        return Some(RuntimeProbeOutput::Found(resolved_executable.to_owned()));
    }
    stdout
        .lines()
        .any(|line| line.trim() == RUNTIME_MISSING_MARKER)
        .then_some(RuntimeProbeOutput::Missing)
}

pub(crate) fn quote_posix_shell_argument(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// A failure that occurs while starting or handshaking one Remote App Server connection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteConnectionError {
    kind: RemoteConnectionFailureKind,
    message: String,
}

impl RemoteConnectionError {
    pub(crate) fn from_client_error(error: ClientError) -> Self {
        match error {
            ClientError::Transport(message) => Self::transport(message),
            ClientError::Protocol(message) => Self::protocol_incompatible(message),
            ClientError::ServerShuttingDown => Self::transport(error.to_string()),
            ClientError::Server { code, message } => {
                Self::server_rejected(format!("server error {code}: {message}"))
            }
        }
    }

    fn transport(message: impl Into<String>) -> Self {
        Self {
            kind: RemoteConnectionFailureKind::Transport,
            message: message.into(),
        }
    }

    fn runtime_unavailable(message: impl Into<String>) -> Self {
        Self {
            kind: RemoteConnectionFailureKind::RuntimeUnavailable,
            message: message.into(),
        }
    }

    fn protocol_incompatible(message: impl Into<String>) -> Self {
        Self {
            kind: RemoteConnectionFailureKind::ProtocolIncompatible,
            message: message.into(),
        }
    }

    fn server_rejected(message: impl Into<String>) -> Self {
        Self {
            kind: RemoteConnectionFailureKind::ServerRejected,
            message: message.into(),
        }
    }

    /// Returns the stable category a Remote coordinator should use for recovery or install UX.
    pub const fn kind(&self) -> RemoteConnectionFailureKind {
        self.kind
    }

    /// Returns the diagnostic without the user-facing error prefix.
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for RemoteConnectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "could not connect to the Remote App Server: {}",
            self.message
        )
    }
}

impl std::error::Error for RemoteConnectionError {}

/// Stable categories for a failed Remote connection attempt.
///
/// `RuntimeUnavailable` is produced by the explicit runtime probe. `ProtocolIncompatible` is
/// produced by the existing initialize/schema gate, so a coordinator can offer install/upgrade
/// only for the former and never silently downgrade an incompatible server.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteConnectionFailureKind {
    Transport,
    RuntimeUnavailable,
    ProtocolIncompatible,
    ServerRejected,
}

/// The result of a successful host-side runtime availability probe.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteRuntimeProbe {
    pub(crate) requested_runtime: RemoteRuntime,
    pub(crate) resolved_runtime: RemoteRuntime,
}

impl RemoteRuntimeProbe {
    /// Returns the runtime reference selected by the Remote profile.
    pub fn requested_executable(&self) -> &str {
        self.requested_runtime.executable()
    }

    /// Returns the executable resolved by the remote shell's `command -v`.
    pub fn resolved_executable(&self) -> &str {
        self.resolved_runtime.executable()
    }

    /// Returns the validated runtime identity resolved by the remote shell.
    pub const fn resolved_runtime(&self) -> &RemoteRuntime {
        &self.resolved_runtime
    }
}
