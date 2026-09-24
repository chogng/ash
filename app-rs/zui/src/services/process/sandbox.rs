//! Strict process-sandbox policy and platform command preparation.

use std::error::Error;
use std::ffi::OsString;
use std::fmt;
use std::path::Path;
use std::path::PathBuf;

use super::ProcessCommand;

#[cfg(target_os = "windows")]
mod windows;

/// Filesystem authority granted to one sandboxed child.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessFileSystemAccess {
    ReadOnly,
    WorkingDirectoryWrite,
    FullAccess,
}

/// Network authority granted to one sandboxed child.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessNetworkAccess {
    Denied,
    Allowed,
}

/// Immutable authority that a process sandbox backend must enforce without fallback.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProcessSandboxPolicy {
    file_system: ProcessFileSystemAccess,
    network: ProcessNetworkAccess,
}

impl ProcessSandboxPolicy {
    /// Creates an explicit filesystem and network authority pair.
    pub const fn new(file_system: ProcessFileSystemAccess, network: ProcessNetworkAccess) -> Self {
        Self {
            file_system,
            network,
        }
    }

    /// Returns the filesystem authority.
    pub const fn file_system(self) -> ProcessFileSystemAccess {
        self.file_system
    }

    /// Returns the network authority.
    pub const fn network(self) -> ProcessNetworkAccess {
        self.network
    }

    /// Returns whether a native enforcement boundary is required.
    pub const fn requires_enforcement(self) -> bool {
        !matches!(
            (self.file_system, self.network),
            (
                ProcessFileSystemAccess::FullAccess,
                ProcessNetworkAccess::Allowed
            )
        )
    }
}

/// Native isolation backend selected for a launched process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessSandboxKind {
    Unrestricted,
    MacOsSeatbelt,
    LinuxBubblewrap,
    WindowsAppContainer,
    Custom,
}

/// Fully materialized, shell-free host command produced by a sandbox backend.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedProcessCommand {
    kind: ProcessSandboxKind,
    program: PathBuf,
    arguments: Vec<OsString>,
    current_directory: Option<PathBuf>,
}

impl PreparedProcessCommand {
    /// Creates a command whose backend identity can be retained by [`super::ChildProcess`].
    pub fn new(
        kind: ProcessSandboxKind,
        program: impl Into<PathBuf>,
        arguments: impl IntoIterator<Item = OsString>,
        current_directory: Option<PathBuf>,
    ) -> Self {
        Self {
            kind,
            program: program.into(),
            arguments: arguments.into_iter().collect(),
            current_directory,
        }
    }

    pub(super) fn unrestricted(command: &ProcessCommand) -> Self {
        Self::new(
            ProcessSandboxKind::Unrestricted,
            command.program(),
            command.arguments().iter().cloned(),
            command.current_directory().map(Path::to_path_buf),
        )
    }

    /// Returns the selected backend identity.
    pub const fn kind(&self) -> ProcessSandboxKind {
        self.kind
    }

    /// Returns the direct host executable.
    pub fn program(&self) -> &Path {
        &self.program
    }

    /// Returns the literal host argument vector.
    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }

    /// Returns the validated host working directory.
    pub fn current_directory(&self) -> Option<&Path> {
        self.current_directory.as_deref()
    }
}

/// Failure to prepare a sandbox without weakening the requested authority.
#[derive(Debug)]
pub struct ProcessSandboxError(Box<dyn Error + Send + Sync>);

impl ProcessSandboxError {
    /// Creates a stable error for a custom sandbox backend.
    pub fn message(message: impl Into<String>) -> Self {
        Self(Box::new(std::io::Error::other(message.into())))
    }

    fn source(source: impl Error + Send + Sync + 'static) -> Self {
        Self(Box::new(source))
    }
}

impl fmt::Display for ProcessSandboxError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "process sandbox preparation failed: {}", self.0)
    }
}

impl Error for ProcessSandboxError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.0.as_ref())
    }
}

/// Converts a managed command into a native isolation host command.
///
/// Implementations must either enforce the complete requested policy or return an error. They
/// must never return an unrestricted command for a policy where [`ProcessSandboxPolicy::requires_enforcement`]
/// is true.
pub trait ProcessSandbox: Send + Sync {
    fn prepare(
        &self,
        command: &ProcessCommand,
        policy: ProcessSandboxPolicy,
    ) -> Result<PreparedProcessCommand, ProcessSandboxError>;
}

/// Built-in macOS Seatbelt, Linux Bubblewrap, or Windows AppContainer adapter.
#[derive(Clone, Debug)]
pub struct PlatformProcessSandbox {
    #[cfg(target_os = "linux")]
    bubblewrap: PathBuf,
    #[cfg(target_os = "windows")]
    appcontainer_runner: PathBuf,
}

impl PlatformProcessSandbox {
    /// Uses a supplied platform helper: Bubblewrap on Linux or the packaged AppContainer runner
    /// on Windows. macOS always uses the system Seatbelt executable.
    pub fn new(platform_helper: impl Into<PathBuf>) -> Self {
        #[cfg(target_os = "linux")]
        {
            Self {
                bubblewrap: platform_helper.into(),
            }
        }
        #[cfg(target_os = "windows")]
        {
            Self {
                appcontainer_runner: platform_helper.into(),
            }
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        {
            let _ = platform_helper.into();
            Self {}
        }
    }
}

impl Default for PlatformProcessSandbox {
    fn default() -> Self {
        #[cfg(target_os = "windows")]
        return Self::new(windows::default_runner_path());
        #[cfg(not(target_os = "windows"))]
        Self::new("bwrap")
    }
}

impl ProcessSandbox for PlatformProcessSandbox {
    fn prepare(
        &self,
        command: &ProcessCommand,
        policy: ProcessSandboxPolicy,
    ) -> Result<PreparedProcessCommand, ProcessSandboxError> {
        if !policy.requires_enforcement() {
            return Ok(PreparedProcessCommand::unrestricted(command));
        }
        let working_directory = canonical_working_directory(command)?;
        #[cfg(target_os = "macos")]
        return Ok(prepare_macos(command, policy, working_directory));
        #[cfg(target_os = "linux")]
        return Ok(prepare_linux(
            &self.bubblewrap,
            command,
            policy,
            working_directory,
        ));
        #[cfg(target_os = "windows")]
        return windows::prepare(
            &self.appcontainer_runner,
            command,
            policy,
            working_directory,
        );
        #[allow(unreachable_code)]
        Err(ProcessSandboxError::message(
            "no strict process sandbox is available on this platform",
        ))
    }
}

/// Entry point for the packaged Windows AppContainer helper.
#[doc(hidden)]
pub fn appcontainer_runner_main() -> ! {
    #[cfg(target_os = "windows")]
    {
        windows::runner_main()
    }
    #[cfg(not(target_os = "windows"))]
    {
        eprintln!("zui-appcontainer-runner is only available on Windows");
        std::process::exit(1)
    }
}

fn canonical_working_directory(command: &ProcessCommand) -> Result<PathBuf, ProcessSandboxError> {
    let directory = command.current_directory().ok_or_else(|| {
        ProcessSandboxError::message("sandboxed commands require an explicit working directory")
    })?;
    let directory = directory
        .canonicalize()
        .map_err(ProcessSandboxError::source)?;
    if !directory.is_dir() {
        return Err(ProcessSandboxError::message(
            "sandbox working directory is not a directory",
        ));
    }
    Ok(directory)
}

#[cfg(target_os = "macos")]
fn prepare_macos(
    command: &ProcessCommand,
    policy: ProcessSandboxPolicy,
    working_directory: PathBuf,
) -> PreparedProcessCommand {
    let mut profile = String::from("(version 1)\n(allow default)\n");
    match policy.file_system() {
        ProcessFileSystemAccess::ReadOnly => profile.push_str("(deny file-write*)\n"),
        ProcessFileSystemAccess::WorkingDirectoryWrite => {
            profile.push_str(&format!(
                "(deny file-write* (require-not (subpath \"{}\")))\n",
                escape_seatbelt_literal(&working_directory.to_string_lossy())
            ));
        }
        ProcessFileSystemAccess::FullAccess => {}
    }
    if policy.network() == ProcessNetworkAccess::Denied {
        profile.push_str("(deny network*)\n");
    }
    let mut arguments = vec![OsString::from("-p"), profile.into(), "--".into()];
    arguments.push(command.program().as_os_str().to_owned());
    arguments.extend(command.arguments().iter().cloned());
    PreparedProcessCommand::new(
        ProcessSandboxKind::MacOsSeatbelt,
        "/usr/bin/sandbox-exec",
        arguments,
        Some(working_directory),
    )
}

#[cfg(target_os = "macos")]
fn escape_seatbelt_literal(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn prepare_linux(
    bubblewrap: &Path,
    command: &ProcessCommand,
    policy: ProcessSandboxPolicy,
    working_directory: PathBuf,
) -> PreparedProcessCommand {
    let root_mount = match policy.file_system() {
        ProcessFileSystemAccess::FullAccess => "--bind",
        ProcessFileSystemAccess::ReadOnly | ProcessFileSystemAccess::WorkingDirectoryWrite => {
            "--ro-bind"
        }
    };
    let mut arguments = vec![
        "--die-with-parent".into(),
        "--new-session".into(),
        "--unshare-user".into(),
        "--unshare-pid".into(),
        root_mount.into(),
        "/".into(),
        "/".into(),
    ];
    if policy.file_system() == ProcessFileSystemAccess::WorkingDirectoryWrite {
        arguments.extend([
            OsString::from("--bind"),
            working_directory.as_os_str().to_owned(),
            working_directory.as_os_str().to_owned(),
        ]);
    }
    if policy.network() == ProcessNetworkAccess::Denied {
        arguments.push("--unshare-net".into());
    }
    arguments.extend([
        OsString::from("--proc"),
        "/proc".into(),
        "--dev".into(),
        "/dev".into(),
        "--chdir".into(),
        working_directory.as_os_str().to_owned(),
        "--".into(),
        command.program().as_os_str().to_owned(),
    ]);
    arguments.extend(command.arguments().iter().cloned());
    PreparedProcessCommand::new(
        ProcessSandboxKind::LinuxBubblewrap,
        bubblewrap,
        arguments,
        Some(working_directory),
    )
}
