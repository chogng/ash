use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

use crate::ExtensionHostError;
use crate::ExtensionHostLimits;
use crate::ExtensionHostOutputEvent;
use crate::ExtensionHostRequest;
use crate::ExtensionHostResponse;
use crate::ProcessIsolationPolicy;
use sha2::Digest;
use sha2::Sha256;

mod node;
mod stdio;

use stdio::StdioExtensionHostProcess;

/// Arguments, working directory, and execution format for one admitted extension.
///
/// Executable packages name their exact installed program; standard JS packages leave runtime
/// selection to the product launcher. This process-local value is never serialized to the child.
#[derive(Clone, Eq, PartialEq)]
pub struct ExtensionLaunchCommand {
    arguments: Vec<OsString>,
    working_directory: PathBuf,
    environment: BTreeMap<OsString, OsString>,
    runtime: LaunchRuntime,
    extension_environment: Option<BTreeMap<String, Option<String>>>,
}

impl std::fmt::Debug for ExtensionLaunchCommand {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ExtensionLaunchCommand")
            .field("runtime", &self.runtime)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum LaunchRuntime {
    Executable(PathBuf),
    JavaScript(PathBuf),
    Vscode,
    Node(PathBuf),
}

impl ExtensionLaunchCommand {
    pub fn new(
        executable: impl Into<PathBuf>,
        arguments: impl IntoIterator<Item = impl Into<OsString>>,
        working_directory: impl Into<PathBuf>,
        environment: BTreeMap<OsString, OsString>,
    ) -> Result<Self, ExtensionHostError> {
        let executable = executable.into();
        let command = Self {
            arguments: arguments.into_iter().map(Into::into).collect(),
            working_directory: working_directory.into(),
            environment,
            extension_environment: None,
            runtime: LaunchRuntime::Executable(executable.clone()),
        };
        if !executable.is_absolute() || !command.working_directory.is_absolute() {
            return Err(ExtensionHostError::InvalidProtocol(
                "extension executable and working directory must be absolute".into(),
            ));
        }
        Ok(command)
    }

    /// Marks a product-owned JS host command, never an executable supplied by a package.
    pub fn javascript(
        executable: impl Into<PathBuf>,
        arguments: impl IntoIterator<Item = impl Into<OsString>>,
        working_directory: impl Into<PathBuf>,
    ) -> Result<Self, ExtensionHostError> {
        let executable = executable.into();
        let mut command = Self::new(
            executable.clone(),
            arguments,
            working_directory,
            BTreeMap::new(),
        )?;
        command.runtime = LaunchRuntime::JavaScript(executable);
        Ok(command)
    }

    /// Requests the product Node host without allowing package data to choose its executable.
    pub fn vscode(
        arguments: impl IntoIterator<Item = impl Into<OsString>>,
        working_directory: impl Into<PathBuf>,
    ) -> Result<Self, ExtensionHostError> {
        let working_directory = working_directory.into();
        if !working_directory.is_absolute() {
            return Err(ExtensionHostError::InvalidProtocol(
                "extension working directory must be absolute".into(),
            ));
        }
        Ok(Self {
            arguments: arguments.into_iter().map(Into::into).collect(),
            working_directory,
            environment: BTreeMap::new(),
            extension_environment: None,
            runtime: LaunchRuntime::Vscode,
        })
    }

    /// These values reach extension code during handshake, never the OS loader or host process.
    pub fn with_extension_environment(
        mut self,
        environment: BTreeMap<String, Option<String>>,
    ) -> Result<Self, ExtensionHostError> {
        external_ext_protocol::validate_environment(&environment)
            .map_err(|error| ExtensionHostError::InvalidProtocol(error.to_string()))?;
        self.extension_environment = Some(environment);
        Ok(self)
    }

    pub(crate) fn extension_environment(&self) -> &Option<BTreeMap<String, Option<String>>> {
        &self.extension_environment
    }

    pub fn is_javascript(&self) -> bool {
        matches!(
            self.runtime,
            LaunchRuntime::JavaScript(_) | LaunchRuntime::Vscode | LaunchRuntime::Node(_)
        )
    }

    pub fn is_vscode(&self) -> bool {
        matches!(self.runtime, LaunchRuntime::Vscode | LaunchRuntime::Node(_))
    }

    /// Returns the exact program, if this command names one rather than requesting the Node host.
    pub fn executable(&self) -> Option<&Path> {
        match &self.runtime {
            LaunchRuntime::Executable(path)
            | LaunchRuntime::JavaScript(path)
            | LaunchRuntime::Node(path) => Some(path),
            LaunchRuntime::Vscode => None,
        }
    }

    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }

    pub fn working_directory(&self) -> &Path {
        &self.working_directory
    }

    pub fn environment(&self) -> &BTreeMap<OsString, OsString> {
        &self.environment
    }

    fn validate_limits(&self, limits: &ExtensionHostLimits) -> Result<(), ExtensionHostError> {
        if self.arguments.len() > limits.maximum_argument_count {
            return Err(ExtensionHostError::QuotaExceeded("process arguments"));
        }
        let argument_bytes = self
            .arguments
            .iter()
            .map(|value| value.to_string_lossy().len())
            .sum::<usize>();
        if argument_bytes > limits.maximum_argument_bytes {
            return Err(ExtensionHostError::QuotaExceeded("process argument bytes"));
        }
        if self.environment.len() > limits.maximum_environment_entries {
            return Err(ExtensionHostError::QuotaExceeded(
                "process environment entries",
            ));
        }
        let environment_bytes = self
            .environment
            .iter()
            .map(|(key, value)| key.to_string_lossy().len() + value.to_string_lossy().len())
            .sum::<usize>();
        if environment_bytes > limits.maximum_environment_bytes {
            return Err(ExtensionHostError::QuotaExceeded(
                "process environment bytes",
            ));
        }
        Ok(())
    }
}

/// Platform process boundary used by the shared supervisor.
///
/// Implementations must apply the selected `limits.isolation` policy before the extension entry
/// point can execute, create a killable process group, apply the explicit environment and connect
/// dedicated protocol pipes. They must fail closed when requested hard limits cannot be enforced.
pub trait ExtensionHostLauncher: Send + Sync {
    fn spawn(
        &self,
        command: &ExtensionLaunchCommand,
        limits: &ExtensionHostLimits,
    ) -> Result<Arc<dyn ExtensionHostProcess>, ExtensionHostError>;
}

/// Concurrent bounded peer for one process incarnation.
///
/// `dispatch` must register the response waiter before writing. Implementations must authorization a
/// cancellation request to be dispatched while an earlier invocation is still pending.
pub trait ExtensionHostProcess: Send + Sync {
    /// Completes a client request previously received through an invocation waiter.
    fn respond_client(
        &self,
        response: external_ext_protocol::ExtensionClientResponse,
    ) -> Result<(), ExtensionHostError>;
    /// Drains bounded lifecycle calls; non-Node peers reject these frames.
    fn drain_background_client_requests(
        &self,
    ) -> Vec<external_ext_protocol::ExtensionBackgroundClientRequest>;

    /// Completes a lifecycle call admitted by this exact process incarnation.
    fn respond_background_client(
        &self,
        response: external_ext_protocol::ExtensionBackgroundClientResponse,
    ) -> Result<(), ExtensionHostError>;

    fn dispatch(
        &self,
        request: ExtensionHostRequest,
    ) -> Result<PendingHostRequest, ExtensionHostError>;

    fn has_exited(&self) -> bool;

    fn terminate(&self) -> Result<(), ExtensionHostError>;

    fn stderr(&self) -> String;

    /// Drains validated unsolicited Output events in stdout arrival order.
    fn drain_output_events(&self) -> Vec<ExtensionHostOutputEvent>;
}

#[derive(Clone, Debug)]
pub(crate) enum PendingFailure {
    Exited,
    Protocol(String),
    Transport,
}

/// Waiter for one response already dispatched to a process incarnation.
pub struct PendingHostRequest {
    request_id: u64,
    receiver: mpsc::Receiver<Result<PendingMessage, PendingFailure>>,
}

#[derive(Debug)]
pub(crate) enum PendingMessage {
    Response(ExtensionHostResponse),
    ClientRequest(external_ext_protocol::ExtensionClientRequest),
}

impl PendingHostRequest {
    pub fn request_id(&self) -> u64 {
        self.request_id
    }

    pub fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> Result<Option<ExtensionHostResponse>, ExtensionHostError> {
        match self.recv_next_timeout(timeout)? {
            Some(PendingMessage::Response(response)) => Ok(Some(response)),
            Some(PendingMessage::ClientRequest(_)) => Err(ExtensionHostError::InvalidProtocol(
                "client request requires an invocation handler".into(),
            )),
            None => Ok(None),
        }
    }

    pub(crate) fn recv_next_timeout(
        &self,
        timeout: Duration,
    ) -> Result<Option<PendingMessage>, ExtensionHostError> {
        match self.receiver.recv_timeout(timeout) {
            Ok(Ok(response)) => Ok(Some(response)),
            Ok(Err(PendingFailure::Exited)) => Err(ExtensionHostError::HostExited),
            Ok(Err(PendingFailure::Protocol(message))) => {
                Err(ExtensionHostError::InvalidProtocol(message))
            }
            Ok(Err(PendingFailure::Transport)) => Err(ExtensionHostError::HostExited),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(ExtensionHostError::HostExited),
        }
    }

    pub(crate) fn channel(
        request_id: u64,
    ) -> (
        Self,
        mpsc::SyncSender<Result<PendingMessage, PendingFailure>>,
    ) {
        let (sender, receiver) = mpsc::sync_channel(64);
        (
            Self {
                request_id,
                receiver,
            },
            sender,
        )
    }
}

struct PendingEntry {
    request: ExtensionHostRequest,
    sender: mpsc::SyncSender<Result<PendingMessage, PendingFailure>>,
    client_ids: std::collections::BTreeSet<u64>,
    last_client_id: u64,
    control: bool,
}

/// Explicitly unsafe-for-production launcher for trusted local runtime development.
///
/// This launcher refuses the default fail-closed isolation policy. Installed third-party code must
/// use its product launcher and the policy selected after execution authorization.
#[derive(Clone, Copy, Debug, Default)]
pub struct TrustedDevelopmentLauncher;

/// Launches the explicitly selected confined V8 executable.
pub struct ProductJavaScriptLauncher {
    executable: PathBuf,
}

/// Binds authorized standard extensions to the installation's Node or Electron runtime.
#[derive(Default)]
pub struct ProductNodeLauncher {
    node: Option<NodeHost>,
}

struct NodeHost {
    executable: PathBuf,
    bootstrap: PathBuf,
    environment: BTreeMap<OsString, OsString>,
    executable_digest: String,
}

impl ProductJavaScriptLauncher {
    /// Platforms with an implemented supervised product JS runtime.
    pub const fn supports_platform() -> bool {
        cfg!(any(
            target_os = "macos",
            target_os = "linux",
            all(windows, target_pointer_width = "64")
        ))
    }

    pub fn new(executable: PathBuf) -> Self {
        Self { executable }
    }
}

impl ProductNodeLauncher {
    pub const fn supports_platform() -> bool {
        ProductJavaScriptLauncher::supports_platform()
    }

    /// Freezes the installation's runtime and bootstrap, never an extension-selected executable.
    pub fn new(
        executable: PathBuf,
        bootstrap: PathBuf,
        environment: BTreeMap<OsString, OsString>,
    ) -> Result<Self, ExtensionHostError> {
        if !executable.is_absolute()
            || !executable.is_file()
            || !bootstrap.is_absolute()
            || !bootstrap.is_file()
        {
            return Err(ExtensionHostError::SpawnFailed);
        }
        Ok(Self {
            node: Some(NodeHost {
                executable_digest: executable_digest(&executable)?,
                executable,
                bootstrap,
                environment,
            }),
        })
    }
}

impl ExtensionHostLauncher for ProductNodeLauncher {
    fn spawn(
        &self,
        command: &ExtensionLaunchCommand,
        limits: &ExtensionHostLimits,
    ) -> Result<Arc<dyn ExtensionHostProcess>, ExtensionHostError> {
        limits.validate()?;
        if !Self::supports_platform()
            || !matches!(command.runtime, LaunchRuntime::Vscode)
            || limits.isolation != ProcessIsolationPolicy::AuthorizedNode
        {
            return Err(ExtensionHostError::IsolationUnavailable);
        }
        let node = self
            .node
            .as_ref()
            .ok_or(ExtensionHostError::IsolationUnavailable)?;
        if executable_digest(&node.executable)? != node.executable_digest {
            return Err(ExtensionHostError::IsolationUnavailable);
        }
        let mut command = command.clone();
        command.runtime = LaunchRuntime::Node(node.executable.clone());
        command
            .arguments
            .insert(0, node.bootstrap.as_os_str().to_owned());
        command.environment = node.environment.clone();
        command.validate_limits(limits)?;
        StdioExtensionHostProcess::spawn(&command, limits).map(|process| Arc::new(process) as _)
    }
}

fn executable_digest(path: &Path) -> Result<String, ExtensionHostError> {
    let mut file = File::open(path).map_err(|_| ExtensionHostError::SpawnFailed)?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| ExtensionHostError::SpawnFailed)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

impl ExtensionHostLauncher for ProductJavaScriptLauncher {
    fn spawn(
        &self,
        command: &ExtensionLaunchCommand,
        limits: &ExtensionHostLimits,
    ) -> Result<Arc<dyn ExtensionHostProcess>, ExtensionHostError> {
        limits.validate()?;
        let ProcessIsolationPolicy::RequireJavaScriptEnforcement(memory) = limits.isolation else {
            return Err(ExtensionHostError::IsolationUnavailable);
        };
        if !Self::supports_platform()
            || !matches!(command.runtime, LaunchRuntime::JavaScript(_))
            || command.executable() != Some(self.executable.as_path())
        {
            return Err(ExtensionHostError::IsolationUnavailable);
        }
        let mut command = command.clone();
        command.arguments.extend([
            "--isolation".into(),
            "javascript".into(),
            "--heap-bytes".into(),
            memory.heap_bytes.to_string().into(),
            "--array-buffer-bytes".into(),
            memory.array_buffer_bytes.to_string().into(),
        ]);
        command.validate_limits(limits)?;
        StdioExtensionHostProcess::spawn(&command, limits).map(|process| Arc::new(process) as _)
    }
}

/// Launches one frozen product executable; package data cannot replace its path.
pub struct ProductExecutableLauncher {
    executable: PathBuf,
}
impl ProductExecutableLauncher {
    pub fn new(executable: PathBuf) -> Result<Self, ExtensionHostError> {
        if !executable.is_absolute() || !executable.is_file() {
            return Err(ExtensionHostError::SpawnFailed);
        }
        Ok(Self { executable })
    }
}
impl ExtensionHostLauncher for ProductExecutableLauncher {
    fn spawn(
        &self,
        command: &ExtensionLaunchCommand,
        limits: &ExtensionHostLimits,
    ) -> Result<Arc<dyn ExtensionHostProcess>, ExtensionHostError> {
        limits.validate()?;
        command.validate_limits(limits)?;
        if !matches!(command.runtime, LaunchRuntime::Executable(_))
            || command.executable() != Some(self.executable.as_path())
            || limits.isolation != ProcessIsolationPolicy::AuthorizedProduct
        {
            return Err(ExtensionHostError::IsolationUnavailable);
        }
        StdioExtensionHostProcess::spawn(command, limits).map(|process| Arc::new(process) as _)
    }
}

impl ExtensionHostLauncher for TrustedDevelopmentLauncher {
    fn spawn(
        &self,
        command: &ExtensionLaunchCommand,
        limits: &ExtensionHostLimits,
    ) -> Result<Arc<dyn ExtensionHostProcess>, ExtensionHostError> {
        limits.validate()?;
        command.validate_limits(limits)?;
        if !matches!(limits.isolation, ProcessIsolationPolicy::TrustedDevelopment) {
            return Err(ExtensionHostError::IsolationUnavailable);
        }
        StdioExtensionHostProcess::spawn(command, limits).map(|process| Arc::new(process) as _)
    }
}

fn reserve_pending(
    pending: &mut BTreeMap<u64, PendingEntry>,
    entry: PendingEntry,
    maximum_requests: usize,
    maximum_control_requests: usize,
) -> Result<(), ExtensionHostError> {
    let request_id = entry.request.context.request_id;
    let in_flight_of_kind = pending
        .values()
        .filter(|pending| pending.control == entry.control)
        .count();
    let maximum = if entry.control {
        maximum_control_requests
    } else {
        maximum_requests
    };
    if in_flight_of_kind >= maximum {
        return Err(ExtensionHostError::QuotaExceeded(if entry.control {
            "in-flight control requests"
        } else {
            "in-flight requests"
        }));
    }
    match pending.entry(request_id) {
        std::collections::btree_map::Entry::Vacant(slot) => {
            slot.insert(entry);
            Ok(())
        }
        std::collections::btree_map::Entry::Occupied(_) => {
            Err(ExtensionHostError::InvalidProtocol(
                "request ID was reused within one process incarnation".into(),
            ))
        }
    }
}

#[cfg(test)]
#[path = "process_tests.rs"]
mod tests;
