use std::collections::BTreeMap;
use std::ffi::OsString;
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

mod stdio;

use stdio::StdioExtensionHostProcess;

/// Exact executable, arguments, working directory, and allowlisted environment for one runtime.
///
/// The executable and working directory must already have been resolved from the immutable package
/// selected by installation authority. This process-local value is never serialized to the child.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtensionLaunchCommand {
    executable: PathBuf,
    arguments: Vec<OsString>,
    working_directory: PathBuf,
    environment: BTreeMap<OsString, OsString>,
    runtime: LaunchRuntime,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LaunchRuntime {
    Executable,
    JavaScript,
}

impl ExtensionLaunchCommand {
    pub fn new(
        executable: impl Into<PathBuf>,
        arguments: impl IntoIterator<Item = impl Into<OsString>>,
        working_directory: impl Into<PathBuf>,
        environment: BTreeMap<OsString, OsString>,
    ) -> Result<Self, ExtensionHostError> {
        let command = Self {
            executable: executable.into(),
            arguments: arguments.into_iter().map(Into::into).collect(),
            working_directory: working_directory.into(),
            environment,
            runtime: LaunchRuntime::Executable,
        };
        if !command.executable.is_absolute() || !command.working_directory.is_absolute() {
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
        let mut command = Self::new(executable, arguments, working_directory, BTreeMap::new())?;
        command.runtime = LaunchRuntime::JavaScript;
        Ok(command)
    }

    pub fn is_javascript(&self) -> bool {
        self.runtime == LaunchRuntime::JavaScript
    }

    pub fn executable(&self) -> &Path {
        &self.executable
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
/// Implementations must install `limits.isolation` before the extension entry point can execute,
/// create a killable process tree, clear inherited environment state, and connect dedicated stdio
/// pipes. They must fail closed when any requested hard limit cannot be enforced.
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
        response: extension_protocol::ExtensionClientResponse,
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
    ClientRequest(extension_protocol::ExtensionClientRequest),
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
    control: bool,
}

/// Explicitly unsafe-for-production launcher for trusted local runtime development.
///
/// This launcher refuses the default fail-closed isolation policy. Installed third-party code must
/// use a platform launcher that implements [`ExtensionHostLauncher`] and enforces hard limits.
#[derive(Clone, Copy, Debug, Default)]
pub struct TrustedDevelopmentLauncher;

/// Launches only the product's exact JS executable. The child applies OS confinement
/// after loading its immutable package and V8, before serving Initialize or running code.
pub struct ProductJavaScriptLauncher {
    executable: PathBuf,
}

impl ProductJavaScriptLauncher {
    pub fn new(executable: PathBuf) -> Self {
        Self { executable }
    }
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
        if !cfg!(target_os = "macos")
            || !command.is_javascript()
            || command.executable() != self.executable
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
