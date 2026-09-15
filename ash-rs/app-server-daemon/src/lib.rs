//! PID-managed App Server lifecycle, control endpoint, and stdio connection carrier.

mod client;
mod endpoint;
mod managed;
mod process;
mod wire;

use std::path::Path;
use std::path::PathBuf;

use serde::Serialize;

/// Environment variable selecting the managed App Server executable.
pub const APP_SERVER_PATH_ENV: &str = "ASH_APP_SERVER_PATH";

/// Selects the managed service role in the App Server executable.
pub const MANAGED_PROCESS_ARGUMENT: &str = "--managed";

/// directory grant source attached to one daemon connection.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum GrantSource {
    /// Grant was resolved by the product host and passed explicitly.
    HostConfiguration,
    /// Grant is resolved from the shared user configuration.
    UserConfig,
}

/// Profile, directory grant, and product-service inputs for one daemon connection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectionOptions {
    profile_root: PathBuf,
    dir_root: Option<PathBuf>,
    dir_grant_source: GrantSource,
    product_services: Option<PathBuf>,
}

impl ConnectionOptions {
    /// Creates the explicit inputs carried in a daemon connection prelude.
    pub fn new(
        profile_root: impl Into<PathBuf>,
        dir_root: Option<PathBuf>,
        dir_grant_source: GrantSource,
        product_services: Option<PathBuf>,
    ) -> Self {
        Self {
            profile_root: profile_root.into(),
            dir_root,
            dir_grant_source,
            product_services,
        }
    }

    /// Returns the shared local profile root.
    pub fn profile_root(&self) -> &Path {
        &self.profile_root
    }

    /// Returns the explicitly selected directory root, when present.
    pub fn dir_root(&self) -> Option<&Path> {
        self.dir_root.as_deref()
    }

    /// Returns the grant source for the selected directory.
    pub fn dir_grant_source(&self) -> GrantSource {
        self.dir_grant_source
    }

    /// Returns the optional product-services manifest for this connection.
    pub fn product_services(&self) -> Option<&Path> {
        self.product_services.as_deref()
    }
}

/// One machine-readable daemon lifecycle operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LifecycleCommand {
    /// Starts the daemon when it is not already ready.
    Start,
    /// Stops a managed daemon and starts a new process generation.
    Restart,
    /// Gracefully stops the managed daemon.
    Stop,
    /// Probes the running daemon and its App Server initialize contract.
    Version,
}

/// Stable lifecycle result status written by product-neutral command hosts.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LifecycleStatus {
    /// The existing daemon was already initialized and compatible.
    AlreadyRunning,
    /// A new daemon process was started and initialized.
    Started,
    /// The previous daemon was stopped and a new generation initialized.
    Restarted,
    /// A running daemon was stopped.
    Stopped,
    /// No daemon is currently running for the profile.
    NotRunning,
    /// The daemon and App Server initialize contract are healthy.
    Running,
}

/// Machine-readable lifecycle output for one profile-scoped daemon.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleOutput {
    /// Operation-specific lifecycle status.
    pub status: LifecycleStatus,
    /// Actual managed App Server process identifier, distinct from the command carrier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// Per-process identity published in the private daemon state directory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    /// Daemon crate version.
    pub daemon_version: String,
    /// Profile-scoped control and App Server socket.
    pub endpoint_path: PathBuf,
    /// Bounded daemon stdout/stderr log.
    pub log_path: PathBuf,
    /// Initialized App Server name, when running and compatible.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_server_name: Option<String>,
    /// Initialized App Server schema identity, when running and compatible.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_hash: Option<String>,
}

/// Runs one serialized lifecycle operation for the selected profile.
#[cfg(any(unix, windows))]
pub fn run_lifecycle(
    command: LifecycleCommand,
    options: ConnectionOptions,
    backend_executable: &Path,
) -> Result<LifecycleOutput, String> {
    client::run_lifecycle(command, options, backend_executable)
}

/// Connects stdio to a ready daemon, starting and probing it first when necessary.
#[cfg(any(unix, windows))]
pub fn connect(options: ConnectionOptions, backend_executable: &Path) -> Result<(), String> {
    client::connect(options, backend_executable)
}

/// Requests a browser listener from the existing managed process and leases it until stdin closes.
#[cfg(any(unix, windows))]
pub fn launch_web(
    options: ConnectionOptions,
    web: ash_app_server_protocol::WebLaunchOptions,
    backend_executable: &Path,
) -> Result<(), String> {
    client::launch_web(options, web, backend_executable)
}

/// Returns the profile-scoped daemon endpoint path used for diagnostics and integration tests.
#[cfg(any(unix, windows))]
pub fn daemon_endpoint_path(profile_root: &Path) -> Result<PathBuf, String> {
    endpoint::EndpointPaths::prepare(profile_root).map(|endpoint| endpoint.socket)
}

#[cfg(not(any(unix, windows)))]
pub fn run_lifecycle(
    _command: LifecycleCommand,
    _options: ConnectionOptions,
    _backend_executable: &Path,
) -> Result<LifecycleOutput, String> {
    Err("Local App Server daemon requires Unix-domain socket support".into())
}

#[cfg(not(any(unix, windows)))]
pub fn connect(_options: ConnectionOptions, _backend_executable: &Path) -> Result<(), String> {
    Err("Local App Server daemon requires Unix-domain socket support".into())
}

/// Reports that this target does not support a local daemon endpoint.
#[cfg(not(any(unix, windows)))]
pub fn daemon_endpoint_path(_profile_root: &Path) -> Result<PathBuf, String> {
    Err("Local App Server daemon requires Unix-domain socket support".into())
}

#[cfg(test)]
#[path = "app_server_daemon_tests.rs"]
mod tests;

mod command;
pub use command::backend_executable_path;
pub use command::run_command;

pub use managed::ManagedConnection;
pub use managed::ManagedEndpoint;
