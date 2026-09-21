//! Process preparation and execution, independent of tool approvals and conversation identity.

#[path = "session.rs"]
mod session;

pub use ash_utils_pty::TerminalSize as CommandTerminalSize;
pub use session::CommandSessionCursor;
pub use session::CommandSessionId;
pub use session::CommandSessionOptions;
pub use session::CommandSessionOutput;
pub use session::CommandSessionStart;
pub use session::CommandSessionStatus;
pub use session::CommandSessionUpdate;
pub use session::ProcessSessionOwner;

use ash_async_utils::CancellationToken;
use ash_file_access::Dir;
use ash_protocol::ProcessExecutionOutput;
use ash_protocol::ProcessExitStatus;
use ash_protocol::SandboxDenialOutput;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::ProcessHandle;
use ash_sandboxing::SandboxBackend;
use ash_sandboxing::SandboxCommand;
use ash_sandboxing::SandboxDenialTiming;
use ash_sandboxing::SandboxError;
use ash_sandboxing::SandboxManager;
use ash_sandboxing::SandboxPolicy;
use ash_sandboxing::SandboxProcessExitStatus;
use ash_sandboxing::SandboxScope;
use std::io::Read;
use std::io::Write;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;
use std::time::Instant;

#[derive(Clone, Debug)]
pub struct CommandRequest {
    pub program: String,
    pub arguments: Vec<String>,
    pub working_directory: PathBuf,
    pub input: CommandInput,
}

/// Bytes supplied to a child process after spawn.
///
/// Callers must choose explicitly between a closed stdin stream and a bounded payload. The
/// executor writes payloads on a dedicated thread so cancellation and timeout monitoring cannot
/// deadlock when a child stops reading.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandInput {
    Closed,
    Bytes(Vec<u8>),
    /// Keep stdin open for subsequent writes through a command session.
    Open,
}

/// Exact process authority selected before execution reaches the host spawn boundary.
///
/// `Sandboxed` requires the configured backend to enforce the supplied policy. `Unrestricted`
/// remains explicit so approval or allow-list decisions never silently become sandbox bypasses.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandExecutionAuthority {
    Sandboxed(SandboxPolicy),
    Unrestricted,
}

impl CommandExecutionAuthority {
    fn sandbox_policy(self) -> SandboxPolicy {
        match self {
            Self::Sandboxed(policy) => policy,
            Self::Unrestricted => {
                SandboxPolicy::new(FileSystemAccess::FullAccess, NetworkAccess::Allowed)
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ExecutionLimits {
    pub timeout: Duration,
    pub max_output_bytes: usize,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandOutput {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

/// Structured result of a process that reached sandbox preparation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandExecutionOutcome {
    Completed(CommandOutput),
    SandboxDenied(SandboxDenialOutput),
}

#[derive(Debug)]
pub enum ExecutionError {
    Spawn(String),
    CancelledBeforeStart(String),
    CancelledAfterStart(String),
    TimedOut,
    Sandbox(SandboxError),
    Network(String),
}

/// Starts approved commands only after the selected sandbox backend prepares their host process.
pub struct ProcessExecutor<B> {
    sandbox: SandboxManager<B>,
    limits: ExecutionLimits,
    sessions: session::CommandSessions,
}

impl<B: SandboxBackend> ProcessExecutor<B> {
    pub fn new(dir: Dir, backend: B, limits: ExecutionLimits) -> Self {
        Self {
            sandbox: SandboxManager::new(dir, backend),
            limits,
            sessions: session::CommandSessions::default(),
        }
    }

    pub fn execute(
        &self,
        request: CommandRequest,
        authority: CommandExecutionAuthority,
        cancellation: &CancellationToken,
    ) -> Result<CommandExecutionOutcome, ExecutionError> {
        self.execute_in_dir(request, authority, cancellation, None)
    }

    pub fn execute_in_dir(
        &self,
        request: CommandRequest,
        authority: CommandExecutionAuthority,
        cancellation: &CancellationToken,
        dir: Option<&Dir>,
    ) -> Result<CommandExecutionOutcome, ExecutionError> {
        let scope = dir.cloned().map(SandboxScope::single);
        self.execute_scoped(request, authority, cancellation, scope.as_ref())
    }

    pub fn execute_scoped(
        &self,
        request: CommandRequest,
        authority: CommandExecutionAuthority,
        cancellation: &CancellationToken,
        scope: Option<&SandboxScope>,
    ) -> Result<CommandExecutionOutcome, ExecutionError> {
        self.execute_scoped_with_network(request, authority, cancellation, scope, None)
    }

    /// Starts an execution-owned proxy before preparing the matching operating-system sandbox.
    pub fn execute_scoped_with_network(
        &self,
        request: CommandRequest,
        authority: CommandExecutionAuthority,
        cancellation: &CancellationToken,
        scope: Option<&SandboxScope>,
        network_policy: Option<&network_proxy::NetworkPolicyHandle>,
    ) -> Result<CommandExecutionOutcome, ExecutionError> {
        if matches!(request.input, CommandInput::Open) {
            return Err(ExecutionError::Spawn(
                "open command input requires the session API".into(),
            ));
        }
        let started = self.start_scoped_with_network(
            request,
            authority,
            cancellation,
            scope,
            network_policy,
            ash_sandboxing::ProcessIo::Pipes,
        )?;
        let StartResult::Started(StartedCommand {
            mut child,
            input,
            authority,
            _runtime_dir,
            _network,
        }) = started
        else {
            let StartResult::Finished(outcome) = started else {
                unreachable!()
            };
            return Ok(outcome);
        };
        let input = input.expect("synchronous execution always supplies an input mode");
        let stdin_writer = match input {
            CommandInput::Closed => {
                drop(child.take_stdin());
                None
            }
            CommandInput::Bytes(bytes) => {
                let mut stdin = child.take_stdin().expect("stdin was piped");
                Some(thread::spawn(move || {
                    stdin.write_all(&bytes).map_err(|error| error.to_string())
                }))
            }
            CommandInput::Open => unreachable!("open input was rejected before process start"),
        };
        let stdout = child.take_stdout().expect("stdout was piped");
        let stderr = child.take_stderr().expect("stderr was piped");
        let max_output_bytes = self.limits.max_output_bytes;
        let stdout_reader = thread::spawn(move || drain_stream(stdout, max_output_bytes));
        let stderr_reader = thread::spawn(move || drain_stream(stderr, max_output_bytes));
        let started = Instant::now();
        let status = loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|error| ExecutionError::Spawn(error.to_string()))?
            {
                break status;
            }
            if let Err(cancellation) = cancellation.check() {
                terminate(&mut child, stdin_writer, stdout_reader, stderr_reader)?;
                return Err(ExecutionError::CancelledAfterStart(
                    cancellation.reason().to_string(),
                ));
            }
            if started.elapsed() >= self.limits.timeout {
                terminate(&mut child, stdin_writer, stdout_reader, stderr_reader)?;
                return Err(ExecutionError::TimedOut);
            }
            thread::sleep(Duration::from_millis(10));
        };
        if let Some(stdin_writer) = stdin_writer {
            stdin_writer
                .join()
                .map_err(|_| ExecutionError::Spawn("stdin writer panicked".into()))?
                .map_err(ExecutionError::Spawn)?;
        }
        let (stdout, stdout_exceeded) = stdout_reader
            .join()
            .map_err(|_| ExecutionError::Spawn("stdout reader panicked".into()))?
            .map_err(ExecutionError::Spawn)?;
        let (stderr, stderr_exceeded) = stderr_reader
            .join()
            .map_err(|_| ExecutionError::Spawn("stderr reader panicked".into()))?
            .map_err(ExecutionError::Spawn)?;
        let stdout_bytes = stdout.len().min(self.limits.max_output_bytes);
        let stderr_budget = self.limits.max_output_bytes.saturating_sub(stdout_bytes);
        let stderr_bytes = stderr.len().min(stderr_budget);
        let stdout_truncated = stdout_exceeded || stdout_bytes < stdout.len();
        let stderr_truncated = stderr_exceeded || stderr_bytes < stderr.len();
        let output = CommandOutput {
            exit_code: status.code(),
            stdout: String::from_utf8_lossy(&stdout[..stdout_bytes]).into_owned(),
            stderr: String::from_utf8_lossy(&stderr[..stderr_bytes]).into_owned(),
            stdout_truncated,
            stderr_truncated,
        };
        if matches!(authority, CommandExecutionAuthority::Sandboxed(_))
            && let Some(denial) = child.classify_denial(
                output.exit_code.map_or(
                    SandboxProcessExitStatus::Terminated,
                    SandboxProcessExitStatus::Code,
                ),
                &output.stdout,
                &output.stderr,
            )
        {
            let output = ProcessExecutionOutput::from_captured_streams(
                output
                    .exit_code
                    .map_or(ProcessExitStatus::Terminated, ProcessExitStatus::Code),
                output.stdout,
                output.stderr,
            );
            let denial = match denial.timing() {
                SandboxDenialTiming::BeforeProcessStart => {
                    SandboxDenialOutput::safe_to_retry(denial.reason(), output)
                }
                SandboxDenialTiming::ProcessMayHaveStarted => {
                    SandboxDenialOutput::may_have_side_effects(denial.reason(), output)
                }
            };
            return Ok(CommandExecutionOutcome::SandboxDenied(denial));
        }
        Ok(CommandExecutionOutcome::Completed(output))
    }

    fn start_scoped_with_network(
        &self,
        request: CommandRequest,
        authority: CommandExecutionAuthority,
        cancellation: &CancellationToken,
        scope: Option<&SandboxScope>,
        network_policy: Option<&network_proxy::NetworkPolicyHandle>,
        io: ash_sandboxing::ProcessIo,
    ) -> Result<StartResult, ExecutionError> {
        check_cancellation_before_start(cancellation)?;
        let CommandRequest {
            program,
            arguments,
            working_directory,
            input,
        } = request;
        let mut command = SandboxCommand::new(program, arguments, working_directory);
        if let ash_sandboxing::ProcessIo::Pty(size) = io {
            command = command.with_pty(size);
        }
        let (runtime_dir, runtime_scope) =
            if matches!(authority, CommandExecutionAuthority::Sandboxed(_)) {
                prepare_runtime_scope(scope, self.sandbox.dir())?
            } else {
                (None, scope.cloned())
            };
        let scope = runtime_scope.as_ref();
        let network = if authority.sandbox_policy().network() == NetworkAccess::Managed {
            let policy = network_policy.ok_or_else(|| {
                ExecutionError::Network(
                    "managed networking has no request authorization authority".into(),
                )
            })?;
            let proxy = if self.sandbox.requires_shared_network_proxy() {
                network_proxy::NetworkProxy::start_shared(policy.clone(), cancellation)
            } else {
                network_proxy::NetworkProxy::start(policy.clone(), cancellation)
            }
            .map_err(|error| ExecutionError::Network(error.to_string()))?;
            command = command.with_network_proxy(ash_sandboxing::ManagedNetworkAccess::new(
                std::num::NonZeroU16::new(proxy.http_port()).expect("bound port"),
                std::num::NonZeroU16::new(proxy.socks_port()).expect("bound port"),
            ));
            Some(proxy)
        } else {
            None
        };
        let prepared = match scope.map_or_else(
            || self.sandbox.prepare(&command, authority.sandbox_policy()),
            |scope| {
                self.sandbox
                    .prepare_scoped(&command, authority.sandbox_policy(), scope)
            },
        ) {
            Ok(prepared) => prepared,
            Err(error @ SandboxError::BackendUnavailable { .. })
                if matches!(authority, CommandExecutionAuthority::Sandboxed(_))
                    && authority.sandbox_policy().network() != NetworkAccess::Managed =>
            {
                return Ok(StartResult::Finished(
                    CommandExecutionOutcome::SandboxDenied(SandboxDenialOutput::safe_to_retry(
                        error.to_string(),
                        ProcessExecutionOutput::from_captured_streams(
                            ProcessExitStatus::Terminated,
                            "",
                            "",
                        ),
                    )),
                ));
            }
            Err(error) => return Err(ExecutionError::Sandbox(error)),
        };
        check_cancellation_before_start(cancellation)?;
        let prepared_kind = prepared.kind();
        if authority.sandbox_policy().network() == NetworkAccess::Managed
            && prepared_kind == ash_sandboxing::SandboxKind::Unrestricted
        {
            return Err(ExecutionError::Network(
                "the backend did not enforce managed network access".into(),
            ));
        }
        let mut environment = execution_environment();
        if let Some(runtime_dir) = runtime_dir.as_ref() {
            let path = runtime_dir.path().to_string_lossy().into_owned();
            for name in ["TMPDIR", "TMP", "TEMP"] {
                environment.retain(|(key, _)| key != name);
                environment.push((name.to_owned(), path.clone()));
            }
        }
        environment.extend(
            network
                .as_ref()
                .map(|proxy| {
                    network_proxy::ProxyEnvironment::new(
                        proxy.http_port().try_into().expect("bound port"),
                        proxy.socks_port().try_into().expect("bound port"),
                    )
                    .variables()
                    .into_iter()
                    .map(|(name, value)| (name.to_owned(), value))
                    .collect::<Vec<_>>()
                })
                .unwrap_or_default(),
        );
        let child = match prepared.spawn(&environment) {
            Ok(child) => child,
            Err(
                error @ SandboxError::StartFailed {
                    timing: SandboxDenialTiming::BeforeProcessStart,
                    ..
                },
            ) if matches!(authority, CommandExecutionAuthority::Sandboxed(_))
                && prepared_kind != ash_sandboxing::SandboxKind::Unrestricted
                && authority.sandbox_policy().network() != NetworkAccess::Managed =>
            {
                return Ok(StartResult::Finished(
                    CommandExecutionOutcome::SandboxDenied(SandboxDenialOutput::safe_to_retry(
                        format!("sandbox launcher could not start: {error}"),
                        ProcessExecutionOutput::from_captured_streams(
                            ProcessExitStatus::Terminated,
                            "",
                            "",
                        ),
                    )),
                ));
            }
            Err(error) => return Err(ExecutionError::Sandbox(error)),
        };
        Ok(StartResult::Started(StartedCommand {
            child,
            input: Some(input),
            authority,
            _runtime_dir: runtime_dir,
            _network: network,
        }))
    }
}

enum StartResult {
    Started(StartedCommand),
    Finished(CommandExecutionOutcome),
}

struct StartedCommand {
    child: ProcessHandle,
    input: Option<CommandInput>,
    authority: CommandExecutionAuthority,
    _runtime_dir: Option<tempfile::TempDir>,
    _network: Option<network_proxy::NetworkProxy>,
}

#[cfg(unix)]
fn prepare_runtime_scope(
    scope: Option<&SandboxScope>,
    default_dir: &Dir,
) -> Result<(Option<tempfile::TempDir>, Option<SandboxScope>), ExecutionError> {
    let runtime_dir = tempfile::Builder::new()
        .prefix("ash-exec-")
        .tempdir()
        .map_err(|error| ExecutionError::Spawn(error.to_string()))?;
    let dir = default_dir
        .directory()
        .driver()
        .open_directory(runtime_dir.path())
        .map(Dir::from_directory)
        .map_err(|error| ExecutionError::Spawn(error.to_string()))?;
    let scope = scope
        .cloned()
        .unwrap_or_else(|| SandboxScope::single(default_dir.clone()))
        .with_private_ipc_dir(dir)
        .map_err(ExecutionError::Sandbox)?;
    Ok((Some(runtime_dir), Some(scope)))
}

#[cfg(not(unix))]
fn prepare_runtime_scope(
    scope: Option<&SandboxScope>,
    _: &Dir,
) -> Result<(Option<tempfile::TempDir>, Option<SandboxScope>), ExecutionError> {
    Ok((None, scope.cloned()))
}

fn execution_environment() -> Vec<(String, String)> {
    [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "TERM",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TMPDIR",
        "TMP",
        "TEMP",
        "SystemRoot",
        "WINDIR",
        "PATHEXT",
        "PSModulePath",
        "COMSPEC",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "CARGO_HOME",
        "RUSTUP_HOME",
        "JAVA_HOME",
        "GOPATH",
    ]
    .into_iter()
    .filter_map(|key| std::env::var(key).ok().map(|value| (key.to_owned(), value)))
    .collect()
}

fn check_cancellation_before_start(cancellation: &CancellationToken) -> Result<(), ExecutionError> {
    cancellation
        .check()
        .map_err(|signal| ExecutionError::CancelledBeforeStart(signal.reason().to_string()))
}

fn terminate(
    child: &mut ProcessHandle,
    stdin_writer: Option<thread::JoinHandle<Result<(), String>>>,
    stdout_reader: thread::JoinHandle<Result<(Vec<u8>, bool), String>>,
    stderr_reader: thread::JoinHandle<Result<(Vec<u8>, bool), String>>,
) -> Result<(), ExecutionError> {
    child
        .close()
        .map_err(|error| ExecutionError::Spawn(error.to_string()))?;
    if let Some(stdin_writer) = stdin_writer {
        let _ = stdin_writer.join();
    }
    let _ = stdout_reader.join();
    let _ = stderr_reader.join();
    Ok(())
}

fn drain_stream(mut stream: impl Read, max_output_bytes: usize) -> Result<(Vec<u8>, bool), String> {
    let mut captured = Vec::new();
    let mut exceeded = false;
    let mut chunk = [0_u8; 8192];
    loop {
        let count = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        let remaining = max_output_bytes.saturating_sub(captured.len());
        let retained = remaining.min(count);
        captured.extend_from_slice(&chunk[..retained]);
        exceeded |= retained != count;
    }
    Ok((captured, exceeded))
}
