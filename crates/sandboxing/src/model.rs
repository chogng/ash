use crate::ProcessHandle;
use crate::SandboxError;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::process::Stdio;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileSystemAccess {
    ReadOnly,
    DirectoryWrite,
    FullAccess,
}

/// Minimum filesystem isolation accepted by the caller, independent of write grants.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileSystemIsolation {
    /// Deny host writes outside the explicitly granted directories.
    Strict,
    /// Windows restricted account, scoped ACLs and bounded writable-path auditing.
    /// This does not establish a host-wide read-only filesystem boundary.
    WindowsAccount,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NetworkAccess {
    Denied,
    Allowed,
    /// Connect only through the execution's host-prepared loopback proxy listeners.
    Managed,
}

/// Exact proxy endpoints supplied by the process owner after its listeners have bound.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ManagedNetworkAccess {
    http_port: std::num::NonZeroU16,
    socks_port: std::num::NonZeroU16,
}

impl ManagedNetworkAccess {
    pub fn new(http_port: std::num::NonZeroU16, socks_port: std::num::NonZeroU16) -> Self {
        Self {
            http_port,
            socks_port,
        }
    }

    pub fn ports(self) -> [u16; 2] {
        [self.http_port.get(), self.socks_port.get()]
    }
}

/// Whether applying isolation may temporarily change the host ACLs of the authorized paths.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostAclChanges {
    Denied,
    Scoped,
    /// Also permit non-inherited attribute-query and traversal ACEs on ancestors
    /// needed to reach the scope. Does not authorize enumeration or file reads.
    ScopedWithTraversal,
}

/// Immutable filesystem and network authority for one local process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SandboxPolicy {
    file_system: FileSystemAccess,
    network: NetworkAccess,
    host_acl_changes: HostAclChanges,
    file_system_isolation: FileSystemIsolation,
}

impl SandboxPolicy {
    pub fn new(file_system: FileSystemAccess, network: NetworkAccess) -> Self {
        Self {
            file_system,
            network,
            host_acl_changes: HostAclChanges::Denied,
            file_system_isolation: FileSystemIsolation::Strict,
        }
    }

    pub fn file_system(self) -> FileSystemAccess {
        self.file_system
    }

    pub fn with_file_system_isolation(mut self, isolation: FileSystemIsolation) -> Self {
        self.file_system_isolation = isolation;
        self
    }

    pub fn file_system_isolation(self) -> FileSystemIsolation {
        self.file_system_isolation
    }

    pub fn network(self) -> NetworkAccess {
        self.network
    }

    pub fn with_host_acl_changes(mut self, changes: HostAclChanges) -> Self {
        self.host_acl_changes = changes;
        self
    }
    pub fn host_acl_changes(self) -> HostAclChanges {
        self.host_acl_changes
    }

    pub fn requires_platform_sandbox(self) -> bool {
        self.file_system != FileSystemAccess::FullAccess || self.network != NetworkAccess::Allowed
    }
}

/// A command whose working directory is relative to its selected directory.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SandboxCommand {
    program: OsString,
    arguments: Vec<OsString>,
    working_directory: PathBuf,
    network_proxy: Option<ManagedNetworkAccess>,
    io: ProcessIo,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessIo {
    Pipes,
    Pty(ash_utils_pty::TerminalSize),
}

impl SandboxCommand {
    pub fn new(
        program: impl Into<OsString>,
        arguments: impl IntoIterator<Item = impl Into<OsString>>,
        working_directory: impl Into<PathBuf>,
    ) -> Self {
        Self {
            program: program.into(),
            arguments: arguments.into_iter().map(Into::into).collect(),
            working_directory: working_directory.into(),
            network_proxy: None,
            io: ProcessIo::Pipes,
        }
    }

    pub fn program(&self) -> &OsStr {
        &self.program
    }

    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }

    pub fn working_directory(&self) -> &Path {
        &self.working_directory
    }

    pub fn with_network_proxy(mut self, access: ManagedNetworkAccess) -> Self {
        self.network_proxy = Some(access);
        self
    }

    pub fn network_proxy(&self) -> Option<ManagedNetworkAccess> {
        self.network_proxy
    }

    pub fn with_pty(mut self, size: ash_utils_pty::TerminalSize) -> Self {
        self.io = ProcessIo::Pty(size);
        self
    }

    pub fn io(&self) -> ProcessIo {
        self.io
    }

    pub(crate) fn with_working_directory(&self, working_directory: PathBuf) -> Self {
        Self {
            program: self.program.clone(),
            arguments: self.arguments.clone(),
            working_directory,
            network_proxy: self.network_proxy,
            io: self.io,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxKind {
    Unrestricted,
    Restricted,
}

/// Process termination shape used by a backend when classifying enforcement output.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxProcessExitStatus {
    Code(i32),
    Terminated,
}

/// Whether sandbox evidence proves the requested child process did not reach its entry point.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxDenialTiming {
    BeforeProcessStart,
    ProcessMayHaveStarted,
}

/// Backend-specific classification of a process result caused by sandbox enforcement.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SandboxProcessDenial {
    reason: String,
    timing: SandboxDenialTiming,
}

impl SandboxProcessDenial {
    pub fn before_process_start(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            timing: SandboxDenialTiming::BeforeProcessStart,
        }
    }

    pub fn process_may_have_started(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            timing: SandboxDenialTiming::ProcessMayHaveStarted,
        }
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }

    pub fn timing(&self) -> SandboxDenialTiming {
        self.timing
    }
}

/// A prepared backend launch. Implementations retain their prepared state until the executor
/// reaches the authorized start boundary; implementation types do not cross this interface.
pub trait SandboxLaunch: Send {
    fn spawn(
        self: Box<Self>,
        environment: &[(String, String)],
    ) -> Result<ProcessHandle, SandboxError>;
}

enum Launch {
    Command,
    Sandbox(Box<dyn SandboxLaunch>),
}

/// A validated launch and its command metadata, ready for the execution boundary.
pub struct PreparedCommand {
    kind: SandboxKind,
    command: SandboxCommand,
    launch: Launch,
    backend: Option<std::sync::Arc<dyn crate::SandboxBackend>>,
}

impl std::fmt::Debug for PreparedCommand {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PreparedCommand")
            .field("kind", &self.kind)
            .field("command", &self.command)
            .finish_non_exhaustive()
    }
}

impl PreparedCommand {
    pub fn new(
        kind: SandboxKind,
        program: impl Into<OsString>,
        arguments: impl IntoIterator<Item = impl Into<OsString>>,
        working_directory: impl Into<PathBuf>,
    ) -> Self {
        Self {
            kind,
            command: SandboxCommand::new(program, arguments, working_directory),
            launch: Launch::Command,
            backend: None,
        }
    }
    pub fn sandboxed(command: &SandboxCommand, launch: impl SandboxLaunch + 'static) -> Self {
        Self {
            kind: SandboxKind::Restricted,
            command: command.clone(),
            launch: Launch::Sandbox(Box::new(launch)),
            backend: None,
        }
    }
    pub fn unrestricted(command: &SandboxCommand) -> Self {
        Self {
            kind: SandboxKind::Unrestricted,
            command: command.clone(),
            launch: Launch::Command,
            backend: None,
        }
    }
    pub fn kind(&self) -> SandboxKind {
        self.kind
    }
    pub fn program(&self) -> &OsStr {
        self.command.program()
    }
    pub fn arguments(&self) -> &[OsString] {
        self.command.arguments()
    }
    pub fn working_directory(&self) -> &Path {
        self.command.working_directory()
    }

    pub(crate) fn with_default_backend(
        mut self,
        backend: std::sync::Arc<dyn crate::SandboxBackend>,
    ) -> Self {
        if self.kind == SandboxKind::Restricted && self.backend.is_none() {
            self.backend = Some(backend);
        }
        self
    }

    pub fn spawn(self, environment: &[(String, String)]) -> Result<ProcessHandle, SandboxError> {
        let process = match self.launch {
            Launch::Sandbox(launch) => launch.spawn(environment),
            Launch::Command => {
                if let ProcessIo::Pty(_) = self.command.io() {
                    return Err(SandboxError::UnsupportedPolicy(
                        "the ordinary process launcher cannot attach a PTY".into(),
                    ));
                }
                let mut command = Command::new(self.command.program());
                command
                    .args(self.command.arguments())
                    .current_dir(self.command.working_directory())
                    .env_clear()
                    .envs(environment.iter().cloned())
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                ProcessHandle::spawn_command(command).map_err(|error| SandboxError::StartFailed {
                    timing: SandboxDenialTiming::BeforeProcessStart,
                    message: error.to_string(),
                })
            }
        }?;
        Ok(process.with_backend(self.backend))
    }
}

impl SandboxProcessExitStatus {
    pub fn code(self) -> Option<i32> {
        match self {
            Self::Code(code) => Some(code),
            Self::Terminated => None,
        }
    }
}
