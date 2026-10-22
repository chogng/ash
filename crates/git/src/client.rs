use install_context::HostExecutableName;
use install_context::SystemExecutables;
use std::ffi::OsStr;
use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;
use std::process::ExitStatus;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;

use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::process::Child;
use tokio::process::ChildStdin;
use tokio::process::ChildStdout;
use tokio::process::Command;
use tokio::sync::OnceCell;
use tokio::task::JoinHandle;
use tokio::time::timeout;

use crate::GitError;
use crate::GitResult;

// Bound retained children across repository owners. Saturation uses the normal
// one-shot Git path rather than queuing UI reads behind inactive repositories.
const MAX_INDEX_BATCH_PROCESSES: usize = 8;
static INDEX_BATCH_PROCESSES: std::sync::LazyLock<Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(MAX_INDEX_BATCH_PROCESSES)));

const DEFAULT_QUERY_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_MUTATION_TIMEOUT: Duration = Duration::from_secs(30);
const CLONE_TIMEOUT: Duration = Duration::from_secs(900);
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
    similarity_threshold: u8,
    askpass: Option<GitAskPass>,
    version: Arc<OnceCell<GitVersion>>,
    process_observer: Option<Arc<dyn GitProcessObserver>>,
    index_batch: Arc<tokio::sync::Mutex<Option<IndexBatchReader>>>,
    pub(crate) content_cache: Arc<std::sync::Mutex<crate::working_copy::ContentCache>>,
}

/// Content-free categories; command arguments and repository paths never reach observers.
#[derive(Clone, Copy, Debug)]
pub enum GitProcessKind {
    Version,
    Show,
    Status,
    RevParse,
    CatFile,
    Diff,
    ForEachRef,
    Config,
    Remote,
    Stash,
    SymbolicRef,
    Other,
}

impl GitProcessKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Version => "version",
            Self::Show => "show",
            Self::Status => "status",
            Self::RevParse => "rev-parse",
            Self::CatFile => "cat-file",
            Self::Diff => "diff",
            Self::ForEachRef => "for-each-ref",
            Self::Config => "config",
            Self::Remote => "remote",
            Self::Stash => "stash",
            Self::SymbolicRef => "symbolic-ref",
            Self::Other => "other",
        }
    }
}

/// Lifetime of an owned process handle, including spawn and pipe capture.
/// For a cancelled stream this ends when the handle is dropped; OS reaping may finish later.
#[derive(Clone, Debug)]
pub struct GitProcessTiming {
    pub kind: GitProcessKind,
    pub started: SystemTime,
    pub spawn_elapsed: Duration,
    pub elapsed: Duration,
}

/// Optional host diagnostics; the Git domain remains independent of a telemetry implementation.
pub trait GitProcessObserver: std::fmt::Debug + Send + Sync {
    fn observe(&self, timing: GitProcessTiming);
}

struct IndexBatchReader {
    git_dir: PathBuf,
    version: crate::working_copy::IndexVersion,
    stream: GitQueryStream,
    // Release capacity after dropping the child/group that occupies it.
    _permit: tokio::sync::OwnedSemaphorePermit,
}

impl std::fmt::Debug for IndexBatchReader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IndexBatchReader").finish_non_exhaustive()
    }
}

struct GitProcessMeasurement {
    observer: Arc<dyn GitProcessObserver>,
    kind: GitProcessKind,
    started: SystemTime,
    clock: Instant,
    spawned: Option<Duration>,
}

impl GitProcessMeasurement {
    fn new(observer: Arc<dyn GitProcessObserver>, invocation: &GitInvocation) -> Self {
        let kind = match invocation.args.first().and_then(|arg| arg.to_str()) {
            Some("--version") => GitProcessKind::Version,
            Some("show") => GitProcessKind::Show,
            Some("status") => GitProcessKind::Status,
            Some("rev-parse") => GitProcessKind::RevParse,
            Some("cat-file") => GitProcessKind::CatFile,
            Some("diff") => GitProcessKind::Diff,
            Some("for-each-ref") => GitProcessKind::ForEachRef,
            Some("config") => GitProcessKind::Config,
            Some("remote") => GitProcessKind::Remote,
            Some("stash") => GitProcessKind::Stash,
            Some("symbolic-ref") => GitProcessKind::SymbolicRef,
            _ => GitProcessKind::Other,
        };
        Self {
            observer,
            kind,
            started: SystemTime::now(),
            clock: Instant::now(),
            spawned: None,
        }
    }
}

impl Drop for GitProcessMeasurement {
    fn drop(&mut self) {
        let elapsed = self.clock.elapsed();
        self.observer.observe(GitProcessTiming {
            kind: self.kind,
            started: self.started,
            spawn_elapsed: self.spawned.unwrap_or(elapsed),
            elapsed,
        });
    }
}

#[derive(Clone, Debug)]
enum ExecutableSource {
    System(SystemExecutables),
    Explicit(PathBuf),
}

/// Retains the spawned group ID even after Git exits while helpers still hold output pipes.
#[cfg(unix)]
struct GitProcessGroup(Option<u32>);

#[cfg(unix)]
impl Drop for GitProcessGroup {
    fn drop(&mut self) {
        if let Some(id) = self.0 {
            let _ = pty::process_group::kill_process_group(id);
        }
    }
}

struct CloneDestination(Option<PathBuf>);

impl Drop for CloneDestination {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            // Only the empty reservation belongs to us. Git owns cleanup of its checkout;
            // partial data remains available after failure or future cancellation.
            let _ = std::fs::remove_dir(path);
        }
    }
}

/// A host-authorized askpass executable and an activation-bound loopback broker.
#[derive(Clone)]
pub struct GitAskPass {
    pub program: PathBuf,
    pub address: std::net::SocketAddr,
    pub token: String,
    pub scope: String,
}
impl std::fmt::Debug for GitAskPass {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GitAskPass")
            .field("program", &self.program)
            .finish_non_exhaustive()
    }
}

impl GitClient {
    /// Uses conventional installation directories, reporting missing Git when an operation starts.
    pub fn system() -> Self {
        Self {
            executable: ExecutableSource::System(SystemExecutables::current()),
            limits: GitExecutionLimits::default(),
            similarity_threshold: 50,
            askpass: None,
            version: Arc::new(OnceCell::new()),
            process_observer: None,
            content_cache: Arc::default(),
            index_batch: Arc::default(),
        }
    }

    /// Changes validated execution limits without resolving the executable. Optional Git
    /// workflows should report a missing installation when invoked, rather than at host startup.
    pub fn with_limits(mut self, limits: GitExecutionLimits) -> Self {
        if self.limits != limits {
            self.index_batch = Arc::default();
        }
        self.limits = limits;
        self
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
            similarity_threshold: 50,
            askpass: None,
            version: Arc::new(OnceCell::new()),
            process_observer: None,
            content_cache: Arc::default(),
            index_batch: Arc::default(),
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

    pub(crate) fn uses_system_executable(&self) -> bool {
        matches!(&self.executable, ExecutableSource::System(_))
    }

    /// Reuses a repository owner's derived reads for the same system Git policy.
    /// Explicit executables remain isolated; invocation credentials are never copied.
    pub fn with_shared_reads(mut self, owner: &Self) -> Self {
        if self.uses_system_executable() && owner.uses_system_executable() {
            self.content_cache = Arc::clone(&owner.content_cache);
            self.version = Arc::clone(&owner.version);
            // A request-bound broker must not be retained by a reusable child.
            if self.askpass.is_none() && owner.askpass.is_none() && self.limits == owner.limits {
                self.index_batch = Arc::clone(&owner.index_batch);
            }
        }
        self
    }

    /// Installs interaction only for this invocation's client, without modifying Git config.
    pub fn with_askpass(mut self, askpass: GitAskPass) -> GitResult<Self> {
        if !askpass.program.is_absolute()
            || askpass.address.ip() != std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
            || askpass.address.port() == 0
            || askpass.token.len() != 64
            || !askpass.token.bytes().all(|byte| byte.is_ascii_hexdigit())
            || askpass.scope.is_empty()
            || askpass.scope.len() > 128
            || askpass.scope.chars().any(char::is_control)
        {
            return Err(GitError::InvalidConfiguration {
                field: "askpass",
                requirement: "must identify a bounded loopback broker and an absolute helper",
            });
        }
        self.askpass = Some(askpass);
        Ok(self)
    }
    /// Overrides rename detection only for this client instance.
    pub fn with_similarity_threshold(mut self, percent: u8) -> GitResult<Self> {
        if percent > 100 {
            return Err(GitError::InvalidConfiguration {
                field: "similarity threshold",
                requirement: "must be between 0 and 100",
            });
        }
        self.similarity_threshold = percent;
        Ok(self)
    }
    pub(crate) fn rename_argument(&self) -> String {
        format!("--find-renames={}%", self.similarity_threshold)
    }

    pub fn limits(&self) -> GitExecutionLimits {
        self.limits
    }

    /// Shares a host observer with cloned clients without changing process execution policy.
    pub fn with_process_observer(mut self, observer: Arc<dyn GitProcessObserver>) -> Self {
        self.process_observer = Some(observer);
        self
    }

    pub(crate) async fn read_index_batch(
        &self,
        repository: &crate::GitRepository,
        path: &Path,
        version: crate::working_copy::IndexVersion,
        maximum_bytes: usize,
    ) -> GitResult<Option<Vec<u8>>> {
        let timeout_duration = self.limits.query_timeout;
        timeout(timeout_duration, async {
            let mut pool = self.index_batch.lock().await;
            // Taking ownership before await makes cancellation poison the partial
            // stream by dropping it, rather than handing unread bytes to a waiter.
            let existing = pool
                .take()
                .filter(|batch| batch.git_dir == repository.git_dir() && batch.version == version);
            let mut batch = match existing {
                Some(batch) => batch,
                None => {
                    let Ok(permit) = Arc::clone(&INDEX_BATCH_PROCESSES).try_acquire_owned() else {
                        let contents = self
                            .read_content_object(
                                repository,
                                path,
                                OsString::from(":"),
                                maximum_bytes,
                            )
                            .await?;
                        if crate::working_copy::index_version(repository).as_ref() != Some(&version)
                        {
                            return Err(GitError::IndexChanged);
                        }
                        return Ok(contents);
                    };
                    let mut invocation = GitInvocation::query(
                        repository.worktree_root(),
                        ["cat-file", "--batch"],
                        FsmonitorOverride::Disabled,
                    );
                    invocation.stdin = Some(Vec::new());
                    let mut client = self.clone();
                    // A persistent process lifetime is not one RPC's Git wall time.
                    client.process_observer = None;
                    IndexBatchReader {
                        _permit: permit,
                        git_dir: repository.git_dir().to_owned(),
                        version: version.clone(),
                        stream: client.start_stream(invocation).await?,
                    }
                }
            };
            let stream = &mut batch.stream;
            #[cfg(not(windows))]
            let path_bytes = path.as_os_str().as_encoded_bytes();
            #[cfg(windows)]
            let normalized = path
                .to_str()
                .ok_or_else(|| GitError::invalid_output(&stream.command, "non-UTF-8 batch path"))?
                .replace('\\', "/");
            #[cfg(windows)]
            let path_bytes = normalized.as_bytes();
            let mut request = Vec::with_capacity(path.as_os_str().len() + 2);
            request.push(b':');
            request.extend_from_slice(path_bytes);
            request.push(b'\n');
            let stdin = stream.stdin.as_mut().expect("batch stdin is captured");
            stdin
                .write_all(&request)
                .await
                .map_err(|e| GitError::io("write Git batch request", e))?;
            stdin
                .flush()
                .await
                .map_err(|e| GitError::io("flush Git batch request", e))?;
            // Framing has its own bounded budget. A tiny content limit must not
            // reject a valid small blob merely because its OID header is longer.
            stream.max_output_bytes = request.len().saturating_add(8).max(128);
            stream.bytes_read = 0;
            let header = stream.next_delimited(b'\n').await?.ok_or_else(|| {
                GitError::invalid_output(&stream.command, "batch header was missing")
            })?;
            let result = if header.ends_with(b" missing") {
                let expected = [&request[..request.len() - 1], b" missing"].concat();
                if header != expected {
                    return Err(GitError::invalid_output(
                        &stream.command,
                        "batch missing result does not match the requested path",
                    ));
                }
                None
            } else {
                let fields = header.split(|b| *b == b' ').collect::<Vec<_>>();
                if fields.len() != 3
                    || fields[1] != b"blob"
                    || !matches!(fields[0].len(), 40 | 64)
                    || !fields[0].iter().all(u8::is_ascii_hexdigit)
                {
                    return Err(GitError::invalid_output(
                        &stream.command,
                        "batch result is not a blob",
                    ));
                }
                let size = std::str::from_utf8(fields[2])
                    .ok()
                    .and_then(|s| s.parse::<usize>().ok())
                    .ok_or_else(|| {
                        GitError::invalid_output(&stream.command, "batch object size is invalid")
                    })?;
                let limit = maximum_bytes.min(self.limits.max_output_bytes);
                if size > limit {
                    return Err(GitError::OutputLimitExceeded {
                        command: stream.command.clone(),
                        stream: "stdout",
                        limit_bytes: limit,
                    });
                }
                let mut contents = vec![0; size];
                stream
                    .stdout
                    .read_exact(&mut contents)
                    .await
                    .map_err(|e| GitError::io("read Git batch content", e))?;
                if stream
                    .stdout
                    .read_u8()
                    .await
                    .map_err(|e| GitError::io("read Git batch terminator", e))?
                    != b'\n'
                {
                    return Err(GitError::invalid_output(
                        &stream.command,
                        "batch content terminator is invalid",
                    ));
                }
                Some(contents)
            };
            // A process caches its index. It may be reused only for the verified
            // generation it actually read, including checks around the first query.
            if crate::working_copy::index_version(repository).as_ref() != Some(&version) {
                return Err(GitError::IndexChanged);
            }
            *pool = Some(batch);
            Ok(result)
        })
        .await
        .map_err(|_| GitError::TimedOut {
            command: "git cat-file --batch".into(),
            timeout: timeout_duration,
        })?
    }

    /// Clones into a new child of an existing destination directory. Concurrent callers reserve
    /// distinct children before launching Git, including callers using aliases of the parent.
    pub async fn clone_repository(&self, url: &str, parent: &Path) -> GitResult<PathBuf> {
        self.clone_repository_reference(url, parent, None).await
    }

    /// Clones into a reserved child folder, selecting a branch or tag when supplied.
    pub async fn clone_repository_reference(
        &self,
        url: &str,
        parent: &Path,
        reference: Option<&str>,
    ) -> GitResult<PathBuf> {
        if let Some(reference) = reference {
            validate_argument(reference)?;
        }
        let url = url.trim();
        if url.is_empty() || url.len() > 4096 || url.chars().any(char::is_control) {
            return Err(GitError::InvalidConfiguration {
                field: "clone URL",
                requirement: "must be a non-empty repository location",
            });
        }
        let source = url.trim_end_matches('/');
        if source
            .split_once("://")
            .is_some_and(|(_, address)| !address.contains('/'))
        {
            return Err(GitError::InvalidConfiguration {
                field: "clone URL",
                requirement: "must end in a repository name",
            });
        }
        // A clone source can be a URL, an scp-style location, or a local path.
        // Local Windows paths use backslashes, including when cloning an existing checkout.
        let name = source
            .rsplit(['/', ':', std::path::MAIN_SEPARATOR])
            .next()
            .unwrap_or_default();
        let name = name.strip_suffix(".git").unwrap_or(name);
        if name.is_empty() || name == "." || name == ".." || name.contains('\\') {
            return Err(GitError::InvalidConfiguration {
                field: "clone URL",
                requirement: "must end in a repository name",
            });
        }
        // Git for Windows cannot create a checkout under an ordinary verbatim
        // (`\\?\`) path. Preserve canonical identity in the path form Git accepts.
        let parent = dunce::canonicalize(parent)
            .map_err(|source| GitError::io("resolve clone destination", source))?;
        if !parent.is_dir() {
            return Err(GitError::InvalidConfiguration {
                field: "clone destination",
                requirement: "must be an existing directory",
            });
        }
        let mut target = None;
        for index in 0..20 {
            let candidate = parent.join(if index == 0 {
                name.to_string()
            } else {
                format!("{name}-{index}")
            });
            // Creating the empty destination is the filesystem's ownership decision. An exists
            // check would allow two concurrent clones to write into the same empty directory.
            match std::fs::create_dir(&candidate) {
                Ok(()) => {
                    target = Some(candidate);
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(GitError::io("reserve clone destination", error)),
            }
        }
        let destination = CloneDestination(Some(target.ok_or_else(|| {
            GitError::runtime(
                "choose clone destination",
                "no unused repository folder name",
            )
        })?));
        self.clone_reserved(url, &parent, destination, reference)
            .await
    }

    /// Reserves an exact new checkout. Existing directories are never adopted or overwritten.
    /// A full commit ID is fetched and verified before publishing the successful checkout.
    pub async fn clone_repository_to(
        &self,
        url: &str,
        target: &Path,
        reference: Option<&str>,
    ) -> GitResult<PathBuf> {
        validate_argument(url)?;
        if let Some(reference) = reference {
            validate_argument(reference)?;
        }
        if !target.is_absolute() {
            return Err(GitError::InvalidConfiguration {
                field: "clone destination",
                requirement: "must be an absolute new directory",
            });
        }
        let name = target.file_name().ok_or_else(|| {
            crate::error::invalid_command("clone destination must have a directory name")
        })?;
        let parent = dunce::canonicalize(target.parent().ok_or_else(|| {
            crate::error::invalid_command("clone destination must have an existing parent")
        })?)
        .map_err(|source| GitError::io("resolve clone destination", source))?;
        let target = parent.join(name);
        std::fs::create_dir(&target)
            .map_err(|source| GitError::io("reserve clone destination", source))?;
        self.clone_reserved(url, &parent, CloneDestination(Some(target)), reference)
            .await
    }

    async fn clone_reserved(
        &self,
        url: &str,
        parent: &Path,
        mut destination: CloneDestination,
        reference: Option<&str>,
    ) -> GitResult<PathBuf> {
        let target = destination.0.as_ref().expect("reserved clone destination");
        let commit = reference
            .filter(|value| {
                matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
            .map(str::to_ascii_lowercase);
        let mut arguments = vec![OsString::from("clone")];
        if commit.is_some() {
            arguments.push(OsString::from("--no-checkout"));
        } else if let Some(reference) = reference {
            arguments.extend([OsString::from("--branch"), OsString::from(reference)]);
        }
        arguments.extend([
            OsString::from("--"),
            OsString::from(url),
            target.as_os_str().to_owned(),
        ]);
        self.run(GitInvocation::clone(parent, arguments))
            .await?
            .require_success()?;
        if let Some(commit) = commit.as_deref() {
            self.run_mutation(target, ["fetch", "--no-tags", "--", "origin", commit])
                .await?
                .require_success()?;
            let revision = format!("{commit}^{{commit}}");
            let resolved = self
                .run_query_unchecked(
                    target,
                    ["rev-parse", "--verify", "--end-of-options", &revision],
                )
                .await?
                .require_success()?;
            if !String::from_utf8_lossy(&resolved.stdout)
                .trim()
                .eq_ignore_ascii_case(commit)
            {
                return Err(crate::error::invalid_command(
                    "clone reference did not resolve to the requested commit",
                ));
            }
            self.run_mutation(target, ["checkout", "--detach", &revision, "--"])
                .await?
                .require_success()?;
            let head = self
                .run_query_unchecked(target, ["rev-parse", "--verify", "HEAD"])
                .await?
                .require_success()?;
            if !String::from_utf8_lossy(&head.stdout)
                .trim()
                .eq_ignore_ascii_case(commit)
            {
                return Err(crate::error::invalid_command(
                    "requested commit was not checked out",
                ));
            }
        }
        Ok(destination
            .0
            .take()
            .expect("successful clone retains destination"))
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

    pub(crate) async fn run_query_with_stdin<I, S>(
        &self,
        cwd: &Path,
        args: I,
        input: Vec<u8>,
    ) -> GitResult<GitCommandOutput>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.run(GitInvocation::query(cwd, args, FsmonitorOverride::Disabled).with_stdin(input))
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

    pub(crate) async fn run_commit_hooks<I, S>(
        &self,
        cwd: &Path,
        args: I,
        input: Vec<u8>,
    ) -> GitResult<GitCommandOutput>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut invocation = GitInvocation::mutation(cwd, args).with_stdin(input);
        invocation.hooks = GitHooks::Enabled;
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

    pub(crate) async fn start_query_stream<I, S>(
        &self,
        cwd: &Path,
        args: I,
    ) -> GitResult<GitQueryStream>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.start_stream(GitInvocation::query(cwd, args, FsmonitorOverride::Disabled))
            .await
    }

    async fn start_stream(&self, invocation: GitInvocation) -> GitResult<GitQueryStream> {
        self.check_supported().await?;
        let (mut command, command_for_log) = self.configure_command(&invocation)?;
        let mut measurement = self
            .process_observer
            .as_ref()
            .map(|observer| GitProcessMeasurement::new(observer.clone(), &invocation));
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
        if let Some(measurement) = &mut measurement {
            measurement.spawned = Some(measurement.clock.elapsed());
        }
        #[cfg(unix)]
        let group = GitProcessGroup(Some(child.id().expect("new Git process has an ID")));
        let stdin = child.stdin.take();
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
            stdin,
            #[cfg(unix)]
            group,
            #[cfg(windows)]
            job,
            stdout: BufReader::new(stdout),
            stderr_task: Some(stderr_task),
            command: command_for_log,
            timeout: invocation.profile.timeout(self.limits),
            max_output_bytes: self.limits.max_output_bytes,
            bytes_read: 0,
            _measurement: measurement,
        })
    }

    fn configure_command(&self, invocation: &GitInvocation) -> GitResult<(Command, String)> {
        let executable = self.executable()?;
        let command_for_log = render_command(&executable, &invocation.args);
        let mut command = Command::new(&executable);
        if let ExecutableSource::System(system) = &self.executable
            && !matches!(
                invocation.profile,
                GitCommandProfile::Mutation | GitCommandProfile::Clone
            )
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
            .arg("color.ui=false")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if invocation.hooks == GitHooks::Disabled {
            command
                .arg("-c")
                .arg(format!("core.hooksPath={DISABLED_HOOKS_PATH}"));
        }
        #[cfg(unix)]
        command.process_group(0);
        invocation.profile.configure(&mut command);
        command.envs(
            invocation
                .environment
                .iter()
                .map(|(name, value)| (name, value)),
        );
        if let Some(broker) = &self.askpass {
            let path = broker.program.to_string_lossy();
            let helper = format!("'{}' --askpass", path.replace('\'', "'\\''"));
            command
                .env("GIT_ASKPASS", &helper)
                .env("SSH_ASKPASS", &broker.program)
                .env("ASH_GIT_BRIDGE_ADDRESS", broker.address.to_string())
                .env("ASH_GIT_BRIDGE_TOKEN", &broker.token)
                .env("ASH_GIT_BRIDGE_SCOPE", &broker.scope);
        }
        command.args(&invocation.args);
        if invocation.stdin.is_some() {
            command.stdin(Stdio::piped());
        } else {
            command.stdin(Stdio::null());
        }
        Ok((command, command_for_log))
    }

    async fn run(&self, invocation: GitInvocation) -> GitResult<GitCommandOutput> {
        self.check_supported().await?;
        self.run_process(invocation).await
    }

    // Version probing uses the same bounded process owner, without recursively
    // entering the gate it is responsible for establishing.
    async fn run_process(&self, invocation: GitInvocation) -> GitResult<GitCommandOutput> {
        let timeout_duration = invocation.profile.timeout(self.limits);
        let (mut command, command_for_log) = self.configure_command(&invocation)?;

        let mut measurement = self
            .process_observer
            .as_ref()
            .map(|observer| GitProcessMeasurement::new(observer.clone(), &invocation));
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
        if let Some(measurement) = &mut measurement {
            measurement.spawned = Some(measurement.clock.elapsed());
        }
        #[cfg(unix)]
        let mut group = GitProcessGroup(Some(child.id().expect("new Git process has an ID")));
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
        #[cfg(unix)]
        if status.success() {
            group.0 = None;
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
    Clone,
}

impl GitCommandProfile {
    fn timeout(&self, limits: GitExecutionLimits) -> Duration {
        match self {
            Self::Query { .. } | Self::ConfigurationProbe => limits.query_timeout,
            Self::Mutation => limits.mutation_timeout,
            Self::Clone => CLONE_TIMEOUT,
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
            Self::Mutation | Self::Clone => {
                command
                    .arg("-c")
                    .arg(FsmonitorOverride::Disabled.git_config());
            }
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum GitHooks {
    Disabled,
    Enabled,
}

struct GitInvocation {
    hooks: GitHooks,
    cwd: PathBuf,
    args: Vec<OsString>,
    profile: GitCommandProfile,
    stdin: Option<Vec<u8>>,
    environment: Vec<(OsString, OsString)>,
}

impl GitInvocation {
    fn clone<I, S>(cwd: &Path, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        Self {
            hooks: GitHooks::Disabled,
            cwd: cwd.to_path_buf(),
            args: collect_args(args),
            profile: GitCommandProfile::Clone,
            stdin: None,
            environment: Vec::new(),
        }
    }
    fn query<I, S>(cwd: &Path, args: I, fsmonitor: FsmonitorOverride) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        Self {
            hooks: GitHooks::Disabled,
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
            hooks: GitHooks::Disabled,
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
            hooks: GitHooks::Disabled,
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
    stdin: Option<ChildStdin>,
    #[cfg(unix)]
    group: GitProcessGroup,
    #[cfg(windows)]
    job: pty::JobObject,
    stdout: BufReader<ChildStdout>,
    stderr_task: Option<JoinHandle<std::io::Result<BoundedRead>>>,
    command: String,
    timeout: Duration,
    max_output_bytes: usize,
    bytes_read: usize,
    _measurement: Option<GitProcessMeasurement>,
}

impl GitQueryStream {
    pub(crate) fn command(&self) -> &str {
        &self.command
    }

    pub(crate) async fn next_field(&mut self) -> GitResult<Option<Vec<u8>>> {
        self.next_delimited(0).await
    }

    /// Discards a complete record without charging it to the retained page's output budget.
    /// Each field still has the normal size and read-time limits.
    pub(crate) async fn discard_fields(&mut self, count: usize) -> GitResult<bool> {
        for index in 0..count {
            if self.next_field().await?.is_none() {
                return if index == 0 {
                    Ok(false)
                } else {
                    Err(GitError::invalid_output(
                        &self.command,
                        "stream ended inside a skipped record",
                    ))
                };
            }
            self.bytes_read = 0;
        }
        Ok(true)
    }

    async fn next_delimited(&mut self, delimiter: u8) -> GitResult<Option<Vec<u8>>> {
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
                    "stream ended inside a delimited field",
                ));
            }
            let terminator = chunk.iter().position(|byte| *byte == delimiter);
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
            #[cfg(unix)]
            {
                self.group.0 = None;
            }
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

pub(crate) fn validate_argument(value: &str) -> GitResult<()> {
    if value.is_empty()
        || value.len() > 4096
        || value.starts_with('-')
        || value.chars().any(char::is_control)
    {
        return Err(crate::error::invalid_command(
            "invalid reference, name or location",
        ));
    }
    Ok(())
}

/// Parsed installation identity, independent of a repository or editor window.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitVersion {
    pub display: String,
    major: u32,
    minor: u32,
    patch: u32,
}
impl GitVersion {
    // Tree replay uses merge-tree --merge-base, introduced in Git 2.40.
    const MINIMUM_SUPPORTED: (u32, u32, u32) = (2, 40, 0);

    /// The shared minimum version, formatted for installation diagnostics.
    pub fn minimum_supported() -> String {
        let (major, minor, patch) = Self::MINIMUM_SUPPORTED;
        format!("{major}.{minor}.{patch}")
    }

    /// Rejects installations that cannot execute Ash's existing Git operations.
    pub fn check_supported(&self) -> GitResult<()> {
        if (self.major, self.minor, self.patch) < Self::MINIMUM_SUPPORTED {
            return Err(GitError::UnsupportedVersion {
                installed: self.display.clone(),
            });
        }
        Ok(())
    }

    fn parse(command: &str, stdout: &[u8]) -> GitResult<Self> {
        let display = std::str::from_utf8(stdout)
            .map_err(|_| GitError::invalid_output(command, "Git version is not UTF-8"))?
            .trim();
        let value = display
            .strip_prefix("git version ")
            .ok_or_else(|| GitError::invalid_output(command, "Git version header is missing"))?;
        let mut numbers = value.split('.');
        let mut component = || {
            numbers
                .next()
                .and_then(|part| {
                    part.split(|character: char| !character.is_ascii_digit())
                        .next()
                })
                .filter(|part| !part.is_empty())
                .and_then(|part| part.parse::<u32>().ok())
                .ok_or_else(|| {
                    GitError::invalid_output(command, "Git version component is invalid")
                })
        };
        let major = component()?;
        let minor = component()?;
        let patch = component()?;
        Ok(Self {
            display: display.into(),
            major,
            minor,
            patch,
        })
    }
}
impl GitClient {
    // A client and its clones share one cancellation-safe installation probe.
    // Recreate the client after changing/upgrading Git; failed probes are retried.
    async fn check_supported(&self) -> GitResult<()> {
        self.version
            .get_or_try_init(|| self.version())
            .await?
            .check_supported()
    }

    /// Reads the installation identity even when it is too old for repository operations.
    pub async fn version(&self) -> GitResult<GitVersion> {
        let output = self
            .run_process(GitInvocation::query(
                &std::env::temp_dir(),
                ["--version"],
                FsmonitorOverride::Disabled,
            ))
            .await?
            .require_success()?;
        GitVersion::parse(&output.command, &output.stdout)
    }
}
