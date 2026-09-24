use std::ffi::OsString;
use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;

use super::SystemServiceError;
use super::blocking::BlockingServiceExecutor;

const PROCESS_SERVICE: &str = "child process";

/// Owned asynchronous result of managed child-process work.
pub type ProcessFuture<T> =
    Pin<Box<dyn Future<Output = Result<T, SystemServiceError>> + Send + 'static>>;

mod sandbox;

pub use sandbox::PlatformProcessSandbox;
pub use sandbox::PreparedProcessCommand;
pub use sandbox::ProcessFileSystemAccess;
pub use sandbox::ProcessNetworkAccess;
pub use sandbox::ProcessSandbox;
pub use sandbox::ProcessSandboxError;
pub use sandbox::ProcessSandboxKind;
pub use sandbox::ProcessSandboxPolicy;
#[doc(hidden)]
pub use sandbox::appcontainer_runner_main;

/// Stable operating-system identity for one spawned child process.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ProcessId(u32);

impl ProcessId {
    /// Creates an identity supplied by a custom process backend.
    pub const fn from_raw(value: u32) -> Self {
        Self(value)
    }

    /// Returns the operating-system process identity.
    pub const fn into_raw(self) -> u32 {
        self.0
    }
}

/// Environment inherited by a child process.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ProcessEnvironment {
    #[default]
    Inherit,
    Clear,
}

/// Standard stream attachment selected for a child process.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ProcessStdio {
    #[default]
    Null,
    Inherit,
}

/// Ownership behavior when the final process handle is dropped.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ProcessDropPolicy {
    #[default]
    Terminate,
    Detach,
}

/// Shell-free command description for a managed child process.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessCommand {
    program: PathBuf,
    arguments: Vec<OsString>,
    current_directory: Option<PathBuf>,
    environment: ProcessEnvironment,
    environment_values: Vec<(OsString, OsString)>,
    removed_environment: Vec<OsString>,
    stdio: ProcessStdio,
    drop_policy: ProcessDropPolicy,
    sandbox_policy: Option<ProcessSandboxPolicy>,
}

impl ProcessCommand {
    /// Creates a command that never invokes a shell.
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            arguments: Vec::new(),
            current_directory: None,
            environment: ProcessEnvironment::Inherit,
            environment_values: Vec::new(),
            removed_environment: Vec::new(),
            stdio: ProcessStdio::Null,
            drop_policy: ProcessDropPolicy::Terminate,
            sandbox_policy: None,
        }
    }

    /// Appends one literal process argument.
    pub fn with_argument(mut self, argument: impl Into<OsString>) -> Self {
        self.arguments.push(argument.into());
        self
    }

    /// Appends literal process arguments.
    pub fn with_arguments(mut self, arguments: impl IntoIterator<Item = OsString>) -> Self {
        self.arguments.extend(arguments);
        self
    }

    /// Sets the child working directory.
    pub fn with_current_directory(mut self, directory: impl Into<PathBuf>) -> Self {
        self.current_directory = Some(directory.into());
        self
    }

    /// Clears inherited environment variables before explicit values are applied.
    pub const fn with_clean_environment(mut self) -> Self {
        self.environment = ProcessEnvironment::Clear;
        self
    }

    /// Sets one explicit environment value without shell interpolation.
    pub fn with_environment_value(
        mut self,
        name: impl Into<OsString>,
        value: impl Into<OsString>,
    ) -> Self {
        self.environment_values.push((name.into(), value.into()));
        self
    }

    /// Removes one inherited environment value.
    pub fn without_environment_value(mut self, name: impl Into<OsString>) -> Self {
        self.removed_environment.push(name.into());
        self
    }

    /// Inherits the parent standard streams instead of connecting them to the null device.
    pub const fn with_inherited_stdio(mut self) -> Self {
        self.stdio = ProcessStdio::Inherit;
        self
    }

    /// Leaves the child running when the final process handle is dropped.
    pub const fn detached(mut self) -> Self {
        self.drop_policy = ProcessDropPolicy::Detach;
        self
    }

    /// Requires the configured process backend to enforce this sandbox policy without fallback.
    pub const fn with_sandbox(mut self, policy: ProcessSandboxPolicy) -> Self {
        self.sandbox_policy = Some(policy);
        self
    }

    /// Returns the executable path.
    pub fn program(&self) -> &Path {
        &self.program
    }

    /// Returns literal arguments in their configured order.
    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }

    /// Returns the configured working directory, if any.
    pub fn current_directory(&self) -> Option<&Path> {
        self.current_directory.as_deref()
    }

    /// Returns the sandbox authority explicitly requested for this command.
    pub const fn sandbox_policy(&self) -> Option<ProcessSandboxPolicy> {
        self.sandbox_policy
    }
}

/// Terminal status of a managed child process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProcessExit {
    pub code: Option<i32>,
    pub success: bool,
}

/// Controller implemented by concrete or test child-process backends.
pub trait ProcessController: Send + Sync {
    /// Returns the child identity.
    fn id(&self) -> ProcessId;

    /// Returns the isolation backend that owns the launched process.
    fn sandbox_kind(&self) -> ProcessSandboxKind {
        ProcessSandboxKind::Unrestricted
    }

    /// Observes terminal status without blocking.
    fn try_wait(&self) -> Result<Option<ProcessExit>, SystemServiceError>;

    /// Waits for terminal status.
    fn wait(&self) -> Result<ProcessExit, SystemServiceError>;

    /// Requests forceful termination.
    fn terminate(&self) -> Result<(), SystemServiceError>;
}

/// Cloneable ownership capability for one child process.
#[derive(Clone)]
pub struct ChildProcess {
    controller: Arc<dyn ProcessController>,
    executor: BlockingServiceExecutor,
}

impl ChildProcess {
    /// Wraps a custom process controller.
    pub fn new(controller: impl ProcessController + 'static) -> Self {
        Self {
            controller: Arc::new(controller),
            executor: BlockingServiceExecutor,
        }
    }

    /// Returns the child identity.
    pub fn id(&self) -> ProcessId {
        self.controller.id()
    }

    /// Returns the isolation backend selected before launch.
    pub fn sandbox_kind(&self) -> ProcessSandboxKind {
        self.controller.sandbox_kind()
    }

    /// Observes terminal status without blocking.
    pub fn try_wait(&self) -> Result<Option<ProcessExit>, SystemServiceError> {
        self.controller.try_wait()
    }

    /// Waits for terminal status without blocking the calling thread.
    ///
    /// The underlying controller wait runs on ZUI's shared service worker pool.
    pub fn wait(&self) -> ProcessFuture<ProcessExit> {
        let controller = self.controller.clone();
        self.executor
            .spawn(PROCESS_SERVICE, move || controller.wait())
    }

    /// Requests forceful termination.
    pub fn terminate(&self) -> Result<(), SystemServiceError> {
        self.controller.terminate()
    }
}

/// Backend used to launch shell-free, lifecycle-owned child processes.
pub trait ProcessService: Send + Sync {
    /// Starts one child process when invoked on ZUI's service worker pool.
    fn spawn(&self, command: ProcessCommand) -> Result<ChildProcess, SystemServiceError>;
}

/// Cloneable application-wide child-process capability.
#[derive(Clone)]
pub struct ProcessHandle {
    service: Arc<dyn ProcessService>,
    executor: BlockingServiceExecutor,
}

impl ProcessHandle {
    pub(crate) fn new(service: impl ProcessService + 'static) -> Self {
        Self {
            service: Arc::new(service),
            executor: BlockingServiceExecutor,
        }
    }

    /// Starts one child process without blocking the calling thread.
    ///
    /// Dropping the future abandons the result; if a child was already created, its configured
    /// [`ProcessDropPolicy`] determines whether it is terminated or detached.
    pub fn spawn(&self, command: ProcessCommand) -> ProcessFuture<ChildProcess> {
        let service = self.service.clone();
        self.executor
            .spawn(PROCESS_SERVICE, move || service.spawn(command))
    }
}

/// Default shell-free operating-system process backend.
#[derive(Clone)]
pub struct SystemProcesses {
    sandbox: Arc<dyn ProcessSandbox>,
}

impl SystemProcesses {
    /// Creates the shell-free process backend with the current platform sandbox adapter.
    pub fn new() -> Self {
        Self {
            sandbox: Arc::new(PlatformProcessSandbox::default()),
        }
    }

    /// Replaces sandbox preparation while retaining ZUI process lifecycle ownership.
    pub fn with_sandbox(mut self, sandbox: impl ProcessSandbox + 'static) -> Self {
        self.sandbox = Arc::new(sandbox);
        self
    }
}

impl Default for SystemProcesses {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessService for SystemProcesses {
    fn spawn(&self, description: ProcessCommand) -> Result<ChildProcess, SystemServiceError> {
        let prepared = match description.sandbox_policy {
            Some(policy) => {
                let prepared = self
                    .sandbox
                    .prepare(&description, policy)
                    .map_err(|source| SystemServiceError::backend(PROCESS_SERVICE, source))?;
                if policy.requires_enforcement()
                    && prepared.kind() == ProcessSandboxKind::Unrestricted
                {
                    return Err(SystemServiceError::backend(
                        PROCESS_SERVICE,
                        ProcessSandboxError::message(
                            "sandbox backend attempted to weaken a restricted policy",
                        ),
                    ));
                }
                prepared
            }
            None => PreparedProcessCommand::unrestricted(&description),
        };
        let mut command = Command::new(prepared.program());
        command.args(prepared.arguments());
        if let Some(directory) = prepared.current_directory() {
            command.current_dir(directory);
        }
        if description.environment == ProcessEnvironment::Clear {
            command.env_clear();
        }
        for name in &description.removed_environment {
            command.env_remove(name);
        }
        for (name, value) in &description.environment_values {
            command.env(name, value);
        }
        match description.stdio {
            ProcessStdio::Null => {
                command
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
            }
            ProcessStdio::Inherit => {
                command
                    .stdin(Stdio::inherit())
                    .stdout(Stdio::inherit())
                    .stderr(Stdio::inherit());
            }
        }
        let child = command
            .spawn()
            .map_err(|source| SystemServiceError::backend(PROCESS_SERVICE, source))?;
        Ok(ChildProcess::new(SystemProcessController {
            id: ProcessId(child.id()),
            sandbox_kind: prepared.kind(),
            state: Mutex::new(SystemProcessState {
                child: Some(child),
                exit: None,
            }),
            drop_policy: description.drop_policy,
        }))
    }
}

struct SystemProcessController {
    id: ProcessId,
    sandbox_kind: ProcessSandboxKind,
    state: Mutex<SystemProcessState>,
    drop_policy: ProcessDropPolicy,
}

struct SystemProcessState {
    child: Option<Child>,
    exit: Option<ProcessExit>,
}

impl ProcessController for SystemProcessController {
    fn id(&self) -> ProcessId {
        self.id
    }

    fn sandbox_kind(&self) -> ProcessSandboxKind {
        self.sandbox_kind
    }

    fn try_wait(&self) -> Result<Option<ProcessExit>, SystemServiceError> {
        let mut state = self.state.lock().expect("child process lock");
        if let Some(exit) = state.exit {
            return Ok(Some(exit));
        }
        let Some(child) = state.child.as_mut() else {
            return Ok(state.exit);
        };
        let status = child
            .try_wait()
            .map_err(|source| SystemServiceError::backend(PROCESS_SERVICE, source))?;
        if let Some(status) = status {
            let exit = process_exit(status);
            state.exit = Some(exit);
            state.child = None;
            Ok(Some(exit))
        } else {
            Ok(None)
        }
    }

    fn wait(&self) -> Result<ProcessExit, SystemServiceError> {
        loop {
            if let Some(exit) = self.try_wait()? {
                return Ok(exit);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    fn terminate(&self) -> Result<(), SystemServiceError> {
        let mut state = self.state.lock().expect("child process lock");
        if let Some(child) = state.child.as_mut() {
            child
                .kill()
                .map_err(|source| SystemServiceError::backend(PROCESS_SERVICE, source))?;
        }
        Ok(())
    }
}

impl Drop for SystemProcessController {
    fn drop(&mut self) {
        if self.drop_policy == ProcessDropPolicy::Terminate
            && let Ok(state) = self.state.get_mut()
            && let Some(child) = state.child.as_mut()
        {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn process_exit(status: std::process::ExitStatus) -> ProcessExit {
    ProcessExit {
        code: status.code(),
        success: status.success(),
    }
}

#[cfg(test)]
#[path = "process_tests.rs"]
mod tests;
