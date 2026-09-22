use install_context::HostExecutableName;
use install_context::SystemExecutables;
use std::ffi::OsStr;
use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;
use std::process::ExitStatus;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::process::Child;
use tokio::process::ChildStdin;
use tokio::process::ChildStdout;
use tokio::process::Command;
use tokio::task::JoinHandle;
use tokio::time::timeout;

use crate::GitError;
use crate::GitResult;

const DEFAULT_QUERY_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_MUTATION_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const DISABLED_HOOKS_PATH: &str = if cfg!(windows) { "NUL" } else { "/dev/null" };
const REPOSITORY_SELECTOR_ENVIRONMENT: [&str; 15] = [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
];

/// Resource limits applied to every system Git process started by [`GitClient`].
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct GitExecutionLimits {
    query_timeout: Duration,
    mutation_timeout: Duration,
    max_output_bytes: usize,
}

impl GitExecutionLimits {
    pub fn new(
        query_timeout: Duration,
        mutation_timeout: Duration,
        max_output_bytes: usize,
    ) -> GitResult<Self> {
        if query_timeout.is_zero() {
            return Err(GitError::InvalidConfiguration {
                field: "query_timeout",
                requirement: "must be non-zero",
            });
        }
        if mutation_timeout.is_zero() {
            return Err(GitError::InvalidConfiguration {
                field: "mutation_timeout",
                requirement: "must be non-zero",
            });
        }
        if max_output_bytes == 0 {
            return Err(GitError::InvalidConfiguration {
                field: "max_output_bytes",
                requirement: "must be non-zero",
            });
        }
        Ok(Self {
            query_timeout,
            mutation_timeout,
            max_output_bytes,
        })
    }

    pub fn query_timeout(self) -> Duration {
        self.query_timeout
    }

    pub fn mutation_timeout(self) -> Duration {
        self.mutation_timeout
    }

    pub fn max_output_bytes(self) -> usize {
        self.max_output_bytes
    }
}

impl Default for GitExecutionLimits {
    fn default() -> Self {
        Self {
            query_timeout: DEFAULT_QUERY_TIMEOUT,
            mutation_timeout: DEFAULT_MUTATION_TIMEOUT,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
        }
    }
}

/// Concrete owner of system Git process identity and execution limits.
#[derive(Clone, Debug)]
pub struct GitClient {
    executable: ExecutableSource,
    limits: GitExecutionLimits,
}

#[derive(Clone, Debug)]
enum ExecutableSource {
    System(SystemExecutables),
    Explicit(PathBuf),
}

impl GitClient {
    /// Uses conventional installation directories, reporting missing Git when an operation starts.
    pub fn system() -> Self {
        Self {
            executable: ExecutableSource::System(SystemExecutables::current()),
            limits: GitExecutionLimits::default(),
        }
    }

    /// Uses a caller-authorized absolute executable path and its inherited process environment.
    pub fn with_executable(executable: PathBuf, limits: GitExecutionLimits) -> GitResult<Self> {
        if !executable.is_absolute() {
            return Err(GitError::InvalidConfiguration {
                field: "executable",
                requirement: "must be absolute",
            });
        }
        Ok(Self {
            executable: ExecutableSource::Explicit(executable),
            limits,
        })
    }

    /// Resolves the selected executable without consulting the working directory or PATH.
    pub fn executable(&self) -> GitResult<PathBuf> {
        match &self.executable {
            ExecutableSource::System(system) => system
                .find(&HostExecutableName::new("git").expect("fixed executable basename"))
                .map_err(|source| GitError::io("locate system Git", source)),
            ExecutableSource::Explicit(path) => Ok(path.clone()),
        }
    }

    pub fn limits(&self) -> GitExecutionLimits {
        self.limits
    }

    pub(crate) async fn discover_repository(&self, cwd: PathBuf) -> GitResult<GitCommandOutput> {
        let key = crate::discovery::Key {
            cwd: cwd.clone(),
            executable: self.executable()?,
            search_path: match &self.executable {
                ExecutableSource::System(system) => Some(
                    system
                        .search_path()
                        .map_err(|source| GitError::io("build system Git PATH", source))?,
                ),
                ExecutableSource::Explicit(_) => None,
            },
            limits: self.limits,
        };
        let client = self.clone();
        crate::discovery::coordinator()
            .query(key, async move {
                client
                    .run_query_unchecked(
                        &cwd,
                        [
                            "rev-parse",
                            "--path-format=absolute",
                            "--show-toplevel",
                            "--absolute-git-dir",
                            "--git-common-dir",
                        ],
                    )
                    .await
            })
            .await
    }

    pub(crate) async fn run_query<I, S>(&self, cwd: &Path, args: I) -> GitResult<GitCommandOutput>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let output = self
            .run(GitInvocation::query(cwd, args, FsmonitorOverride::Disabled))
            .await?;
        output.require_success()
    }

    pub(crate) async fn run_query_with_fsmonitor<I, S>(
        &self,
        cwd: &Path,
        args: I,
        fsmonitor: FsmonitorOverride,
    ) -> GitResult<GitCommandOutput>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let output = self.run(GitInvocation::query(cwd, args, fsmonitor)).await?;
        output.require_success()
    }

    pub(crate) async fn run_query_unchecked<I, S>(
        &self,
        cwd: &Path,
        args: I,
    ) -> GitResult<GitCommandOutput>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.run(GitInvocation::query(cwd, args, FsmonitorOverride::Disabled))
            .await
    }

    pub(crate) async fn run_configuration_probe<I, S>(
        &self,
        cwd: &Path,
        args: I,
    ) -> GitResult<GitCommandOutput>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.run(GitInvocation::configuration_probe(cwd, args))
            .await
    }

    pub(crate) async fn run_mutation_with_stdin<I, S>(
        &self,
        cwd: &Path,
        args: I,
        input: Vec<u8>,
    ) -> GitResult<GitCommandOutput>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.run(GitInvocation::mutation(cwd, args).with_stdin(input))
            .await
    }

    pub(crate) async fn run_mutation_with_stdin_and_environment<I, S, E, K, V>(
        &self,
        cwd: &Path,
        args: I,
        input: Vec<u8>,
        environment: E,
    ) -> GitResult<GitCommandOutput>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
        E: IntoIterator<Item = (K, V)>,
        K: Into<OsString>,
        V: AsRef<OsStr>,
    {
        let invocation = environment.into_iter().fold(
            GitInvocation::mutation(cwd, args).with_stdin(input),
            |invocation, (name, value)| invocation.with_environment(name, value.as_ref()),
        );
        self.run(invocation).await
    }

    pub(crate) async fn run_mutation<I, S>(
        &self,
        cwd: &Path,
        args: I,
    ) -> GitResult<GitCommandOutput>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.run(GitInvocation::mutation(cwd, args)).await
    }

    pub(crate) async fn run_mutation_with_index<I, S>(
        &self,
        cwd: &Path,
        args: I,
        index_path: &Path,
    ) -> GitResult<GitCommandOutput>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.run(
            GitInvocation::mutation(cwd, args)
                .with_environment("GIT_INDEX_FILE", index_path.as_os_str()),
        )
        .await
    }

    pub(crate) fn start_query_stream<I, S>(&self, cwd: &Path, args: I) -> GitResult<GitQueryStream>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let invocation = GitInvocation::query(cwd, args, FsmonitorOverride::Disabled);
        let (mut command, command_for_log) = self.configure_command(&invocation)?;
        command.stdin(Stdio::null());
        #[cfg(windows)]
        let job = pty::JobObject::create()
            .map_err(|source| GitError::io("create Git process job", source))?;
        #[cfg(windows)]
        let mut child = job
            .spawn_contained(&mut command)
            .map_err(|source| GitError::io("spawn Git process", source))?;
        #[cfg(not(windows))]
        let mut child = command
            .spawn()
            .map_err(|source| GitError::io("spawn Git process", source))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| GitError::runtime("capture Git stdout", "stdout pipe was missing"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| GitError::runtime("capture Git stderr", "stderr pipe was missing"))?;
        let stderr_task = tokio::spawn(read_bounded(stderr, self.limits.max_output_bytes));
        Ok(GitQueryStream {
            child,
            #[cfg(windows)]
            job,
            stdout: BufReader::new(stdout),
            stderr_task: Some(stderr_task),
            command: command_for_log,
            timeout: invocation.profile.timeout(self.limits),
            max_output_bytes: self.limits.max_output_bytes,
            bytes_read: 0,
        })
    }

    fn configure_command(&self, invocation: &GitInvocation) -> GitResult<(Command, String)> {
        let executable = self.executable()?;
        let command_for_log = render_command(&executable, &invocation.args);
        let mut command = Command::new(&executable);
        if let ExecutableSource::System(system) = &self.executable
            && !matches!(invocation.profile, GitCommandProfile::Mutation)
        {
            command.env(
                "PATH",
                system
                    .search_path()
                    .map_err(|source| GitError::io("build system Git PATH", source))?,
            );
        }
        for name in REPOSITORY_SELECTOR_ENVIRONMENT {
            command.env_remove(name);
        }
        command
            .current_dir(&invocation.cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "Never")
            .env("LC_ALL", "C")
            .arg("-c")
            .arg(format!("core.hooksPath={DISABLED_HOOKS_PATH}"))
            .arg("-c")
            .arg("color.ui=false")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        invocation.profile.configure(&mut command);
        command.envs(
            invocation
                .environment
                .iter()
                .map(|(name, value)| (name, value)),
        );
        command.args(&invocation.args);
        if invocation.stdin.is_some() {
            command.stdin(Stdio::piped());
        } else {
            command.stdin(Stdio::null());
        }
        Ok((command, command_for_log))
    }

    async fn run(&self, invocation: GitInvocation) -> GitResult<GitCommandOutput> {
        let timeout_duration = invocation.profile.timeout(self.limits);
        let (mut command, command_for_log) = self.configure_command(&invocation)?;

        #[cfg(windows)]
        let job = pty::JobObject::create()
            .map_err(|source| GitError::io("create Git process job", source))?;
        #[cfg(windows)]
        let mut child = job
            .spawn_contained(&mut command)
            .map_err(|source| GitError::io("spawn Git process", source))?;
        #[cfg(not(windows))]
        let mut child = command
            .spawn()
            .map_err(|source| GitError::io("spawn Git process", source))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| GitError::runtime("capture Git stdout", "stdout pipe was missing"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| GitError::runtime("capture Git stderr", "stderr pipe was missing"))?;
        let stdin = child.stdin.take();
        let captured = timeout(timeout_duration, async {
            tokio::try_join!(
                child.wait(),
                read_bounded(stdout, self.limits.max_output_bytes),
                read_bounded(stderr, self.limits.max_output_bytes),
                async {
                    match invocation.stdin {
                        Some(input) => write_stdin(stdin, input).await,
                        None => Ok(()),
                    }
                },
            )
        })
        .await;
        let (status, stdout, stderr, ()) = match captured {
            Ok(result) => result.map_err(|source| GitError::io("capture Git process", source))?,
            Err(_) => {
                #[cfg(windows)]
                job.terminate()
                    .map_err(|source| GitError::io("terminate Git process job", source))?;
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(GitError::TimedOut {
                    command: command_for_log,
                    timeout: timeout_duration,
                });
            }
        };
        if stdout.truncated {
            return Err(GitError::OutputLimitExceeded {
                command: command_for_log,
                stream: "stdout",
                limit_bytes: self.limits.max_output_bytes,
            });
        }
        if stderr.truncated {
            return Err(GitError::OutputLimitExceeded {
                command: command_for_log,
                stream: "stderr",
                limit_bytes: self.limits.max_output_bytes,
            });
        }
        #[cfg(windows)]
        if status.success() {
            job.preserve_descendants()
                .map_err(|source| GitError::io("release completed Git process job", source))?;
        }
        Ok(GitCommandOutput {
            command: command_for_log,
            status,
            stdout: stdout.bytes,
            stderr: stderr.bytes,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum FsmonitorOverride {
    Disabled,
    BuiltIn,
}

impl FsmonitorOverride {
    fn git_config(self) -> &'static str {
        match self {
            Self::Disabled => "core.fsmonitor=false",
            Self::BuiltIn => "core.fsmonitor=true",
        }
    }
}

enum GitCommandProfile {
    Query { fsmonitor: FsmonitorOverride },
    ConfigurationProbe,
    Mutation,
}

impl GitCommandProfile {
    fn timeout(&self, limits: GitExecutionLimits) -> Duration {
        match self {
            Self::Query { .. } | Self::ConfigurationProbe => limits.query_timeout,
            Self::Mutation => limits.mutation_timeout,
        }
    }

    fn configure(&self, command: &mut Command) {
        match self {
            Self::Query { fsmonitor } => {
                command
                    .env("GIT_OPTIONAL_LOCKS", "0")
                    .arg("-c")
                    .arg(fsmonitor.git_config());
            }
            Self::ConfigurationProbe => {
                command.env("GIT_OPTIONAL_LOCKS", "0");
            }
            Self::Mutation => {
                command
                    .arg("-c")
                    .arg(FsmonitorOverride::Disabled.git_config());
            }
        }
    }
}

struct GitInvocation {
    cwd: PathBuf,
    args: Vec<OsString>,
    profile: GitCommandProfile,
    stdin: Option<Vec<u8>>,
    environment: Vec<(OsString, OsString)>,
}

impl GitInvocation {
    fn query<I, S>(cwd: &Path, args: I, fsmonitor: FsmonitorOverride) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        Self {
            cwd: cwd.to_path_buf(),
            args: collect_args(args),
            profile: GitCommandProfile::Query { fsmonitor },
            stdin: None,
            environment: Vec::new(),
        }
    }

    fn configuration_probe<I, S>(cwd: &Path, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        Self {
            cwd: cwd.to_path_buf(),
            args: collect_args(args),
            profile: GitCommandProfile::ConfigurationProbe,
            stdin: None,
            environment: Vec::new(),
        }
    }

    fn mutation<I, S>(cwd: &Path, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        Self {
            cwd: cwd.to_path_buf(),
            args: collect_args(args),
            profile: GitCommandProfile::Mutation,
            stdin: None,
            environment: Vec::new(),
        }
    }

    fn with_stdin(mut self, stdin: Vec<u8>) -> Self {
        self.stdin = Some(stdin);
        self
    }

    fn with_environment(mut self, name: impl Into<OsString>, value: &OsStr) -> Self {
        self.environment.push((name.into(), value.to_owned()));
        self
    }
}

#[derive(Clone, Debug)]
pub(crate) struct GitCommandOutput {
    pub(crate) command: String,
    pub(crate) status: ExitStatus,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
}

pub(crate) struct GitQueryStream {
    child: Child,
    #[cfg(windows)]
    job: pty::JobObject,
    stdout: BufReader<ChildStdout>,
    stderr_task: Option<JoinHandle<std::io::Result<BoundedRead>>>,
    command: String,
    timeout: Duration,
    max_output_bytes: usize,
    bytes_read: usize,
}

impl GitQueryStream {
    pub(crate) fn command(&self) -> &str {
        &self.command
    }

    pub(crate) async fn next_field(&mut self) -> GitResult<Option<Vec<u8>>> {
        let mut field = Vec::new();
        loop {
            let chunk = timeout(self.timeout, self.stdout.fill_buf())
                .await
                .map_err(|_| GitError::TimedOut {
                    command: self.command.clone(),
                    timeout: self.timeout,
                })?
                .map_err(|source| GitError::io("read Git stdout", source))?;
            if chunk.is_empty() {
                if field.is_empty() {
                    return Ok(None);
                }
                return Err(GitError::invalid_output(
                    &self.command,
                    "stream ended inside a NUL-delimited field",
                ));
            }
            let terminator = chunk.iter().position(|byte| *byte == 0);
            let data_len = terminator.unwrap_or(chunk.len());
            let consumed = data_len + usize::from(terminator.is_some());
            let next_size =
                self.bytes_read
                    .checked_add(consumed)
                    .ok_or(GitError::OutputLimitExceeded {
                        command: self.command.clone(),
                        stream: "stdout",
                        limit_bytes: self.max_output_bytes,
                    })?;
            if next_size > self.max_output_bytes {
                self.stdout.consume(consumed);
                return Err(GitError::OutputLimitExceeded {
                    command: self.command.clone(),
                    stream: "stdout",
                    limit_bytes: self.max_output_bytes,
                });
            }
            field.extend_from_slice(&chunk[..data_len]);
            self.bytes_read = next_size;
            self.stdout.consume(consumed);
            if terminator.is_some() {
                return Ok(Some(field));
            }
        }
    }

    pub(crate) async fn finish(mut self) -> GitResult<()> {
        let status = match timeout(self.timeout, self.child.wait()).await {
            Ok(result) => result.map_err(|source| GitError::io("wait for Git process", source))?,
            Err(_) => {
                #[cfg(windows)]
                self.job
                    .terminate()
                    .map_err(|source| GitError::io("terminate Git process job", source))?;
                let _ = self.child.kill().await;
                let _ = self.child.wait().await;
                if let Some(stderr_task) = self.stderr_task.take() {
                    stderr_task.abort();
                }
                return Err(GitError::TimedOut {
                    command: self.command.clone(),
                    timeout: self.timeout,
                });
            }
        };
        let stderr = timeout(
            self.timeout,
            self.stderr_task
                .as_mut()
                .expect("Git query stream stderr task is present before finish"),
        )
        .await
        .map_err(|_| GitError::TimedOut {
            command: self.command.clone(),
            timeout: self.timeout,
        })?
        .map_err(|error| GitError::runtime("join Git output reader", error.to_string()))?
        .map_err(|source| GitError::io("read Git output", source))?;
        self.stderr_task.take();
        if stderr.truncated {
            return Err(GitError::OutputLimitExceeded {
                command: self.command.clone(),
                stream: "stderr",
                limit_bytes: self.max_output_bytes,
            });
        }
        if status.success() {
            #[cfg(windows)]
            self.job
                .preserve_descendants()
                .map_err(|source| GitError::io("release completed Git process job", source))?;
            return Ok(());
        }
        Err(GitError::CommandFailed {
            command: self.command.clone(),
            exit_code: status.code(),
            stderr: String::from_utf8_lossy(&stderr.bytes).trim().to_string(),
        })
    }
}

impl Drop for GitQueryStream {
    fn drop(&mut self) {
        if let Some(stderr_task) = self.stderr_task.take() {
            stderr_task.abort();
        }
    }
}

impl GitCommandOutput {
    pub(crate) fn require_success(self) -> GitResult<Self> {
        if self.status.success() {
            return Ok(self);
        }
        Err(GitError::CommandFailed {
            command: self.command,
            exit_code: self.status.code(),
            stderr: String::from_utf8_lossy(&self.stderr).trim().to_string(),
        })
    }
}

struct BoundedRead {
    bytes: Vec<u8>,
    truncated: bool,
}

async fn read_bounded(
    mut reader: impl AsyncRead + Unpin,
    max_bytes: usize,
) -> std::io::Result<BoundedRead> {
    let mut bytes = Vec::with_capacity(max_bytes.min(64 * 1024));
    let mut chunk = [0_u8; 16 * 1024];
    let mut truncated = false;
    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        let remaining = max_bytes.saturating_sub(bytes.len());
        let retained = remaining.min(read);
        bytes.extend_from_slice(&chunk[..retained]);
        truncated |= retained < read;
    }
    Ok(BoundedRead { bytes, truncated })
}

async fn write_stdin(stdin: Option<ChildStdin>, input: Vec<u8>) -> std::io::Result<()> {
    let Some(mut stdin) = stdin else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "Git stdin pipe was missing",
        ));
    };
    match stdin.write_all(&input).await {
        Ok(()) => stdin.shutdown().await,
        Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
        Err(error) => Err(error),
    }
}

fn collect_args<I, S>(args: I) -> Vec<OsString>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .map(|argument| argument.as_ref().to_os_string())
        .collect()
}

fn render_command(executable: &Path, args: &[OsString]) -> String {
    std::iter::once(executable.as_os_str())
        .chain(args.iter().map(OsString::as_os_str))
        .map(|argument| quote_for_log(&argument.to_string_lossy()))
        .collect::<Vec<_>>()
        .join(" ")
}

fn quote_for_log(argument: &str) -> String {
    if argument
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "-_./:=@%+".contains(character))
    {
        argument.to_string()
    } else {
        format!("'{}'", argument.replace('\'', "'\\''"))
    }
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
