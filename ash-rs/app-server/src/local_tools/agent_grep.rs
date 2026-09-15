use super::suite::ResolvedFilePath;
use super::suite::limit_matches;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_config::AgentGrepBackend;
use ash_core::ToolExecutionOutput;
use ash_file_access::Dir;
use ash_file_access::DirId;
use ash_file_watcher::FileWatcherEvent;
use ash_install_context::InstallContext;
use ash_shell_command::RipgrepExecutable;
use ash_state::DirIndexKind;
use ash_state::DirIndexLease;
use ash_state::StateRuntime;
use core_api::CoreError;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::process::Command;
use std::process::Output;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

const SEARCH_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESULT_LINE_CHARS: usize = 500;

/// Agent grep backend and owned workspace search sessions. Editor search remains independent.
pub(crate) struct AgentGrepService {
    backend: AgentGrepBackend,
    ripgrep: RipgrepExecutable,
    indexes: Arc<TgrepIndexes>,
}
struct TgrepIndexes {
    enabled: AtomicBool,
    executable: tgrep::Executable,
    storage: Option<Arc<StateRuntime>>,
    indexes: Mutex<BTreeMap<DirId, Arc<ManagedTgrep>>>,
    changed_paths: Mutex<BTreeMap<DirId, BTreeSet<PathBuf>>>,
}
struct ManagedTgrep {
    search: tgrep::Session,
    _lease: Option<DirIndexLease>,
    _temporary: Option<tempfile::TempDir>,
}
impl AgentGrepService {
    pub(crate) fn new(
        backend: AgentGrepBackend,
        ripgrep: RipgrepExecutable,
        storage: Option<Arc<StateRuntime>>,
    ) -> Result<Self, tgrep::Error> {
        let executable = tgrep::Executable::resolve(&InstallContext::current())?;
        Ok(Self {
            backend,
            ripgrep,
            indexes: Arc::new(TgrepIndexes {
                enabled: AtomicBool::new(backend == AgentGrepBackend::Tgrep),
                executable,
                storage,
                indexes: Mutex::new(BTreeMap::new()),
                changed_paths: Mutex::new(BTreeMap::new()),
            }),
        })
    }
    pub(crate) fn reconfigured(
        &self,
        backend: AgentGrepBackend,
        ripgrep: RipgrepExecutable,
    ) -> Self {
        let enabled = backend == AgentGrepBackend::Tgrep;
        if self.indexes.enabled.swap(enabled, Ordering::AcqRel) != enabled {
            self.indexes
                .indexes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clear();
        }
        Self {
            backend,
            ripgrep,
            indexes: Arc::clone(&self.indexes),
        }
    }
    pub(super) fn execute(
        &self,
        pattern: String,
        path: &ResolvedFilePath,
        glob: Option<String>,
        case_insensitive: bool,
        cancellation: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        match self.backend {
            AgentGrepBackend::Ripgrep => {
                self.execute_ripgrep(pattern, path, glob, case_insensitive, cancellation)
            }
            AgentGrepBackend::Tgrep => {
                self.execute_tgrep(pattern, path, glob, case_insensitive, cancellation)
            }
        }
    }
    pub(crate) fn apply_watcher_event(&self, root: &Dir, event: &FileWatcherEvent) {
        // Called synchronously after an Ash edit. Filesystem watching belongs to tgrep.
        if let FileWatcherEvent::PathsChanged { paths } = event {
            let indexes = self
                .indexes
                .indexes
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(index) = indexes.get(&root.id()) {
                index.search.paths_changed(paths);
            }
            self.indexes
                .changed_paths
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .entry(root.id())
                .or_default()
                .extend(paths.iter().cloned());
        }
    }
    pub(crate) fn tgrep_enabled(&self) -> bool {
        self.indexes.enabled.load(Ordering::Acquire)
    }
    pub(crate) fn tgrep_snapshot(&self, root: &Dir) -> Result<Option<tgrep::Status>, tgrep::Error> {
        let index = self
            .indexes
            .indexes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&root.id())
            .cloned();
        index
            .map(|index| index.search.status(&CancellationSource::new().token()))
            .transpose()
    }
    pub(crate) fn rebuild_tgrep(&self, root: &Dir) -> Result<tgrep::Status, tgrep::Error> {
        let cancellation = CancellationSource::new();
        self.index_for(root, &cancellation.token())?
            .search
            .rebuild(&cancellation.token())
    }
    fn index_for(
        &self,
        root: &Dir,
        cancellation: &CancellationToken,
    ) -> Result<Arc<ManagedTgrep>, tgrep::Error> {
        if !self.tgrep_enabled() {
            return Err(tgrep::Error::Failed("tgrep is disabled".into()));
        }
        let mut indexes = self
            .indexes
            .indexes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(index) = indexes.get(&root.id()) {
            return Ok(Arc::clone(index));
        }
        let lease = self
            .indexes
            .storage
            .as_ref()
            .map(|s| s.acquire(&root.id(), DirIndexKind::AgentGrep))
            .transpose()?;
        let temporary = if lease.is_none() {
            Some(tempfile::tempdir()?)
        } else {
            None
        };
        let base = lease
            .as_ref()
            .map(|l| l.directory())
            .or_else(|| temporary.as_ref().map(|t| t.path()))
            .expect("index storage");
        let search = tgrep::Session::open(
            self.indexes.executable.clone(),
            root.canonical_path(),
            &base.join("tgrep-1.0.8"),
            cancellation,
        )?;
        if let Some(paths) = self
            .indexes
            .changed_paths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&root.id())
        {
            search.paths_changed(&paths.iter().cloned().collect::<Vec<_>>());
        }
        let index = Arc::new(ManagedTgrep {
            search,
            _lease: lease,
            _temporary: temporary,
        });
        indexes.insert(root.id(), Arc::clone(&index));
        Ok(index)
    }
    fn execute_tgrep(
        &self,
        pattern: String,
        path: &ResolvedFilePath,
        glob: Option<String>,
        case_insensitive: bool,
        cancellation: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let run = || {
            let index = self.index_for(&path.root, cancellation)?;
            index.search.search(
                &tgrep::Query {
                    pattern: &pattern,
                    scope: &path.relative,
                    case_insensitive,
                    include: glob.as_deref(),
                    exclude: super::LOCAL_DENIED_GLOBS,
                },
                cancellation,
            )
        };
        let result = match run() {
            Ok(result) => result,
            Err(tgrep::Error::Cancelled(reason)) => return Err(CoreError::Cancelled(reason)),
            Err(error) => return Ok(ToolExecutionOutput::Failure(error.to_string())),
        };
        if result.matches.is_empty() {
            return Ok(ToolExecutionOutput::Success(
                if result.indexed {
                    "no matches in indexed files (filesystem updates are applied asynchronously)"
                } else {
                    "no matches"
                }
                .into(),
            ));
        }
        let text = result
            .matches
            .into_iter()
            .map(|found| {
                format!(
                    "{}:{}:{}",
                    path.root.canonical_path().join(found.path).display(),
                    found.line_number,
                    found.content
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let mut output = limit_matches(&text, MAX_RESULT_LINE_CHARS);
        if result.limit_hit {
            output.push_str("\n[more than 100 matches, showing first 100]");
        }
        Ok(ToolExecutionOutput::Success(output))
    }
    fn execute_ripgrep(
        &self,
        pattern: String,
        path: &ResolvedFilePath,
        glob: Option<String>,
        case_insensitive: bool,
        cancellation: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let mut command = Command::new(self.ripgrep.path());
        command.args(["--no-config", "-n", "--no-heading"]);
        if case_insensitive {
            command.arg("-i");
        }
        if let Some(glob) = glob {
            command.args(["--glob", &glob]);
        }
        for glob in super::LOCAL_DENIED_GLOBS {
            command.args(["--glob", &format!("!{glob}")]);
        }
        command.arg("--").arg(pattern).arg(&path.absolute);
        let output = match run_search(command, cancellation) {
            Ok(output) => output,
            Err(SearchError::Cancelled(error)) => return Err(error),
            Err(SearchError::Failed(message)) => return Ok(ToolExecutionOutput::Failure(message)),
        };
        if output.status.code() == Some(1) {
            return Ok(ToolExecutionOutput::Success("no matches".into()));
        }
        if !output.status.success() {
            return Ok(ToolExecutionOutput::Failure(format!(
                "{}\nescape literal characters like . ( ) {{ }} with a backslash",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        Ok(ToolExecutionOutput::Success(limit_matches(
            &String::from_utf8_lossy(&output.stdout),
            MAX_RESULT_LINE_CHARS,
        )))
    }
}

enum SearchError {
    Cancelled(CoreError),
    Failed(String),
}

fn run_search(
    mut command: Command,
    cancellation: &CancellationToken,
) -> Result<Output, SearchError> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| SearchError::Failed(format!("could not execute search: {error}")))?;
    let started = Instant::now();
    loop {
        cancellation.check().map_err(|signal| {
            SearchError::Cancelled(CoreError::Cancelled(signal.reason().to_string()))
        })?;
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|error| SearchError::Failed(error.to_string()));
            }
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(SearchError::Failed(format!(
                    "could not wait for search: {error}"
                )));
            }
        }
        if started.elapsed() >= SEARCH_TIMEOUT {
            let _ = child.kill();
            let output = child
                .wait_with_output()
                .map_err(|error| SearchError::Failed(error.to_string()))?;
            let partial = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return Err(SearchError::Failed(format!(
                "search timed out after 30000 ms. Partial output:\n{partial}"
            )));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
#[path = "agent_grep_tests.rs"]
mod tests;
