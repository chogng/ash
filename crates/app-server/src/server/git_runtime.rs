//! Shared directory Git orchestration; editor extension enablement does not own this runtime.
use super::update_broker::UpdateBroker;
use crate::git_service::GitService;
use crate::git_service::GitServiceCommit;
use crate::git_service::GitServiceError;
use ash_app_server_protocol::protocol::git::GitBranchDto;
use ash_app_server_protocol::protocol::git::GitChangeFileComparisonDto;
use ash_app_server_protocol::protocol::git::GitChangeFileResult;
use ash_app_server_protocol::protocol::git::GitChangeStatusDto;
use ash_app_server_protocol::protocol::git::GitCommitChangeDto;
use ash_app_server_protocol::protocol::git::GitCommitChangesResult;
use ash_app_server_protocol::protocol::git::GitCommitFileContentDto;
use ash_app_server_protocol::protocol::git::GitCommitFileResult;
use ash_app_server_protocol::protocol::git::GitCommitSummaryDto;
use ash_app_server_protocol::protocol::git::GitCompareChangesResult;
use ash_app_server_protocol::protocol::git::GitConflictFileResult;
use ash_app_server_protocol::protocol::git::GitConflictResolutionDto;
use ash_app_server_protocol::protocol::git::GitDiffStatisticsDto;
use ash_app_server_protocol::protocol::git::GitFetchModeDto;
use ash_app_server_protocol::protocol::git::GitGraphResult;
use ash_app_server_protocol::protocol::git::GitHeadDto;
use ash_app_server_protocol::protocol::git::GitHistoryRefsResult;
use ash_app_server_protocol::protocol::git::GitIgnoreChanged;
use ash_app_server_protocol::protocol::git::GitReferenceDto;
use ash_app_server_protocol::protocol::git::GitReferenceKindDto;
use ash_app_server_protocol::protocol::git::GitRemoteDto;
use ash_app_server_protocol::protocol::git::GitRemoteProviderDto;
use ash_app_server_protocol::protocol::git::GitRepositoriesResult;
use ash_app_server_protocol::protocol::git::GitRepositoryChangeDto;
use ash_app_server_protocol::protocol::git::GitRepositoryDto;
use ash_app_server_protocol::protocol::git::GitRepositoryIdentityDto;
use ash_app_server_protocol::protocol::git::GitStatusResult;
use ash_app_server_protocol::protocol::git::GitSubmoduleStateDto;
use ash_app_server_protocol::protocol::git::GitTextDiffDto;
use ash_app_server_protocol::protocol::git::GitTextDiffResult;
use ash_app_server_protocol::protocol::git::GitUpstreamDto;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_config::ConfigStore;
use ash_config::GitAutoFetchMode;
use ash_file_access::Authorization;
use ash_file_watcher::DebouncedWatchReceiver;
use ash_file_watcher::FileWatcher;
use ash_file_watcher::FileWatcherBackend;
use ash_file_watcher::FileWatcherEvent;
use ash_file_watcher::WatchPath;
use ash_git::GitChangeFileComparison;
use ash_git::GitChangeStatus;
use ash_git::GitCommitChange;
use ash_git::GitGraph;
use ash_git::GitGraphCursor;
use ash_git::GitHead;
use ash_git::GitPullMode;
use ash_git::GitReferenceKind;
use ash_git::GitRemoteProvider;
use ash_git::GitRepository;
use ash_git::GitRepositoryChange;
use ash_git::GitRepositorySnapshot;
use ash_protocol::StreamInstanceId;
use base64::Engine;
use ignore::WalkBuilder;
use sha2::Digest;
use sha2::Sha256;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;
use std::time::Instant;

const GIT_WATCH_DEBOUNCE: Duration = Duration::from_millis(100);
const ALIASED_PATH_POLL_INTERVAL: Duration = Duration::from_millis(100);

pub(crate) struct GitRuntime {
    dirs: Vec<(Option<String>, Authorization)>,
    dir_order: HashMap<String, usize>,
    updates: Arc<UpdateBroker>,
    discovery: Mutex<()>,
    discovery_interests: Mutex<HashMap<u64, Vec<GitDiscoveryOptions>>>,
    registry: RwLock<GitRepositoryRegistry>,
}

/// Ephemeral query preferences; the frontend configuration service owns persisted values.
#[derive(Clone)]
pub(super) struct GitDiscoveryOptions {
    pub dir_id: Option<String>,
    pub max_depth: i32,
    pub ignored_folders: Vec<String>,
    pub scan_repositories: Vec<String>,
    pub detect_submodules: bool,
    pub submodule_limit: usize,
    pub detect_worktrees: bool,
    pub worktree_limit: usize,
}
impl Default for GitDiscoveryOptions {
    fn default() -> Self {
        Self {
            dir_id: None,
            max_depth: 1,
            ignored_folders: vec![
                "node_modules".into(),
                "target".into(),
                ".build".into(),
                "out".into(),
                "dist".into(),
                ".cache".into(),
            ],
            scan_repositories: vec![],
            detect_submodules: true,
            submodule_limit: 10,
            detect_worktrees: false,
            worktree_limit: 50,
        }
    }
}

#[derive(Default)]
struct GitRepositoryRegistry {
    repositories: Vec<Arc<GitRepositoryRuntime>>,
    repositories_by_id: HashMap<String, Arc<GitRepositoryRuntime>>,
}

struct GitRepositoryRuntime {
    descriptor: GitRepositoryDto,
    service: GitService,
    stream_instance_id: StreamInstanceId,
    operation: Arc<ash_git::RepositoryOperationLock>,
    common_dir: PathBuf,
    identity: GitRepository,
    ignore_watch_paths: Mutex<Vec<PathBuf>>,
    state: Mutex<GitRuntimeState>,
    graph_sessions: Mutex<HashMap<u64, GraphSession>>,
    next_graph_token: AtomicU64,
    updates: Arc<UpdateBroker>,
}

#[derive(Default)]
pub(super) struct GitWatcher {
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    auto_fetch_shutdown: Option<mpsc::Sender<()>>,
    cancellation: Option<CancellationSource>,
    thread: Option<JoinHandle<()>>,
    children: Vec<GitWatcher>,
}

struct GitRuntimeState {
    revision: u64,
    history_revision: u64,
    graph_revision: u64,
    graph_roots: Vec<String>,
    repository: Option<GitRepository>,
    status: Option<GitStatusResult>,
    references: Option<ash_git::GitReferenceState>,
}

struct GraphSession {
    token: String,
    cursor: GitGraphCursor,
    revisions: Option<Vec<String>>,
}

#[derive(Clone, Copy)]
enum StatusNotification {
    OnChange,
    Always,
}

pub(super) struct GitRuntimeCommit {
    pub(super) object_id: String,
    pub(super) status: GitStatusResult,
}

#[derive(Debug)]
pub(crate) enum GitRuntimeError {
    Boundary,
    InvalidGraphCursor,
    RepositoryNotFound,
    Service(GitServiceError),
}

impl GitRuntime {
    pub(super) fn new(
        authorization: Authorization,
        updates: Arc<UpdateBroker>,
    ) -> Result<Arc<Self>, GitRuntimeError> {
        Self::new_dirs(vec![(None, authorization)], HashMap::new(), updates)
    }

    pub(super) fn new_for_dirs(
        dirs: Vec<(String, Authorization)>,
        updates: Arc<UpdateBroker>,
    ) -> Result<Arc<Self>, GitRuntimeError> {
        let dir_order = dirs
            .iter()
            .enumerate()
            .map(|(index, (id, _))| (id.clone(), index))
            .collect();
        let mut dirs = dirs
            .into_iter()
            .map(|(id, authorization)| (Some(id), authorization))
            .collect::<Vec<_>>();
        dirs.sort_by_key(|(_, authorization)| {
            std::cmp::Reverse(authorization.dir().canonical_path().components().count())
        });
        Self::new_dirs(dirs, dir_order, updates)
    }

    fn new_dirs(
        dirs: Vec<(Option<String>, Authorization)>,
        dir_order: HashMap<String, usize>,
        updates: Arc<UpdateBroker>,
    ) -> Result<Arc<Self>, GitRuntimeError> {
        let runtime = Arc::new(Self {
            dirs,
            dir_order,
            updates,
            discovery: Mutex::new(()),
            discovery_interests: Mutex::new(HashMap::new()),
            registry: RwLock::new(GitRepositoryRegistry::default()),
        });
        runtime.reconcile_with_notification(false, &CancellationSource::new().token())?;
        Ok(runtime)
    }

    pub(super) fn initialize(
        &self,
        root: &Path,
        branch: &str,
        cancellation: &CancellationToken,
    ) -> Result<(), GitRuntimeError> {
        let authorized = self.dirs.iter().any(|(_, authorization)| {
            authorization.dir().canonical_path() == root
                && authorization.permission() == ash_file_access::Permission::MutateRepository
                && authorization.ensure_active().is_ok()
        });
        if !authorized {
            return Err(GitRuntimeError::Service(GitServiceError::Permission));
        }
        let executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        use ash_async_utils::FutureCancellationExt;
        executor
            .block_on(
                crate::git_service::current_client()
                    .initialize_repository(root, branch)
                    .with_cancellation(cancellation.clone()),
            )
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Cancelled))?
            .map_err(|error| GitRuntimeError::Service(GitServiceError::Git(error)))?;
        Ok(())
    }

    /// Keep unchanged repository owners alive: their streams and graph cursors belong to clients.
    pub(super) fn reconcile(&self) -> Result<(), GitRuntimeError> {
        self.reconcile_with_notification(true, &CancellationSource::new().token())
    }

    fn reconcile_with_notification(
        &self,
        notify: bool,
        cancellation: &CancellationToken,
    ) -> Result<(), GitRuntimeError> {
        let _discovery = crate::git_service::lock_for_request(&self.discovery, cancellation)
            .map_err(GitRuntimeError::Service)?;
        let previous = self.repository_runtimes();
        let mut repositories = Vec::new();
        let mut worktrees = Vec::<PathBuf>::new();
        let interests = self
            .discovery_interests
            .lock()
            .expect("Git discovery interests")
            .clone();
        for (dir_id, authorization) in &self.dirs {
            let mut roots =
                discover_repository_roots(authorization, &GitDiscoveryOptions::default());
            for options in interests
                .values()
                .flatten()
                .filter(|options| options.dir_id.as_ref() == dir_id.as_ref())
            {
                roots.extend(discover_repository_roots(authorization, options));
            }
            roots.sort();
            roots.dedup();
            for root in roots {
                cancellation
                    .check()
                    .map_err(|_| GitRuntimeError::Service(GitServiceError::Cancelled))?;
                if !root.is_dir() {
                    continue;
                }
                let descriptor = repository_descriptor(dir_id.clone(), authorization, &root)?;
                let existing = previous
                    .iter()
                    .find(|runtime| runtime.descriptor == descriptor);
                let runtime = if let Some(existing) = existing
                    && existing
                        .service
                        .repository_for_request(cancellation)
                        .is_ok_and(|identity| identity == existing.identity)
                {
                    Arc::clone(existing)
                } else {
                    let Some(runtime) = GitRepositoryRuntime::new(
                        authorization.clone(),
                        root,
                        descriptor,
                        Arc::clone(&self.updates),
                        cancellation,
                    )?
                    else {
                        continue;
                    };
                    Arc::new(runtime)
                };
                if worktrees
                    .iter()
                    .any(|root| root == runtime.identity.worktree_root())
                {
                    continue;
                }
                worktrees.push(runtime.identity.worktree_root().to_path_buf());
                repositories.push(runtime);
            }
        }
        repositories.sort_by(|left, right| {
            let order = |runtime: &GitRepositoryRuntime| {
                runtime
                    .descriptor
                    .dir_id
                    .as_ref()
                    .and_then(|id| self.dir_order.get(id))
                    .copied()
                    .unwrap_or(usize::MAX)
            };
            order(left)
                .cmp(&order(right))
                .then(left.descriptor.path.cmp(&right.descriptor.path))
        });
        let unchanged = previous.len() == repositories.len()
            && previous
                .iter()
                .zip(&repositories)
                .all(|(left, right)| Arc::ptr_eq(left, right));
        cancellation
            .check()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Cancelled))?;
        if !unchanged {
            let repositories_by_id = repositories
                .iter()
                .map(|runtime| (runtime.descriptor.id.clone(), Arc::clone(runtime)))
                .collect();
            *self
                .registry
                .write()
                .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))? =
                GitRepositoryRegistry {
                    repositories,
                    repositories_by_id,
                };
            if notify {
                self.updates.publish_git_repositories_changed();
            }
        }
        Ok(())
    }

    fn repository_runtimes(&self) -> Vec<Arc<GitRepositoryRuntime>> {
        self.registry
            .read()
            .expect("Git repository registry poisoned")
            .repositories
            .clone()
    }

    pub(super) fn discover_for(
        &self,
        connection_id: u64,
        folders: Option<Vec<GitDiscoveryOptions>>,
    ) -> Result<GitRepositoriesResult, GitRuntimeError> {
        if let Some(folders) = folders {
            if folders.len() > self.dirs.len()
                || folders
                    .iter()
                    .any(|options| !self.dirs.iter().any(|(id, _)| id == &options.dir_id))
            {
                return Err(GitRuntimeError::Boundary);
            }
            for options in &folders {
                let authorization = &self
                    .dirs
                    .iter()
                    .find(|(id, _)| id == &options.dir_id)
                    .expect("validated discovery directory")
                    .1;
                for path in &options.scan_repositories {
                    let path = Path::new(path);
                    let path = if path.is_absolute() {
                        path.to_path_buf()
                    } else {
                        authorization.dir().canonical_path().join(path)
                    };
                    if let Ok(path) = dunce::canonicalize(path) {
                        if !path.starts_with(authorization.dir().canonical_path()) {
                            return Err(GitRuntimeError::Boundary);
                        }
                    }
                }
            }
            self.discovery_interests
                .lock()
                .expect("Git discovery interests")
                .insert(connection_id, folders);
            self.reconcile()?;
        }
        let interests = self
            .discovery_interests
            .lock()
            .expect("Git discovery interests")
            .get(&connection_id)
            .cloned();
        let Some(interests) = interests else {
            return Ok(self.repositories());
        };
        let mut roots = Vec::new();
        for options in interests {
            if let Some((_, authorization)) = self.dirs.iter().find(|(id, _)| id == &options.dir_id)
            {
                roots.extend(discover_repository_roots(authorization, &options));
            }
        }
        let ids = self
            .repository_runtimes()
            .iter()
            .filter(|runtime| roots.iter().any(|root| root == runtime.service.dir_root()))
            .map(|runtime| runtime.descriptor.id.clone())
            .collect::<std::collections::HashSet<_>>();
        let mut result = self.repositories();
        result
            .repositories
            .retain(|repository| ids.contains(&repository.id));
        Ok(result)
    }

    pub(super) fn repositories(&self) -> GitRepositoriesResult {
        GitRepositoriesResult {
            repositories: self
                .repository_runtimes()
                .iter()
                .map(|runtime| {
                    let mut descriptor = runtime.descriptor.clone();
                    if runtime.identity.worktree_root() != runtime.service.dir_root() {
                        descriptor.parent_path =
                            runtime.identity.worktree_root().to_str().map(str::to_owned);
                    }
                    descriptor
                })
                .collect(),
        }
    }

    pub(super) fn status_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.repository(repository_id)?.status()
    }

    /// Applies a caller's rename classification only to its returned view. Canonical status,
    /// event revisions and other windows retain their single shared runtime owner.
    pub(super) fn status_view_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        let runtime = self.repository(repository_id)?;
        let _operation = lock_current_operation(&runtime.operation)
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        for _ in 0..2 {
            let (repository, canonical) = runtime
                .service
                .snapshot()
                .map_err(GitRuntimeError::Service)?;
            let status = runtime.accept(repository.clone(), canonical.clone())?;
            let (view_repository, view) = runtime
                .service
                .view_snapshot()
                .map_err(GitRuntimeError::Service)?;
            let (latest_repository, latest) = runtime
                .service
                .snapshot()
                .map_err(GitRuntimeError::Service)?;
            if repository != latest_repository
                || repository != view_repository
                || canonical != latest
            {
                continue;
            }
            let mut result = project_status(
                runtime.descriptor.id.clone(),
                runtime.stream_instance_id.clone(),
                runtime.service.dir_root(),
                &repository,
                view,
            )?;
            result.revision = status.revision;
            result.history_revision = status.history_revision;
            return Ok(result);
        }
        Err(GitRuntimeError::Service(GitServiceError::ConflictChanged))
    }

    #[cfg(test)]
    pub(super) fn status(&self) -> Result<GitStatusResult, GitRuntimeError> {
        self.status_for(None)
    }

    pub(super) fn pull_upstream_was_rewritten_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<bool, GitRuntimeError> {
        self.repository(repository_id)?
            .service
            .pull_upstream_was_rewritten()
            .map_err(GitRuntimeError::Service)
    }

    pub(super) fn check_ignore_for(
        &self,
        repository_id: Option<&str>,
        paths: &[PathBuf],
        cancellation: &CancellationToken,
    ) -> Result<Vec<PathBuf>, GitRuntimeError> {
        self.repository(repository_id)?
            .service
            .check_ignore(paths, cancellation)
            .map_err(GitRuntimeError::Service)
    }

    pub(super) fn blame_for(
        &self,
        repository_id: Option<&str>,
        path: &Path,
        line: usize,
        ignore_whitespace: bool,
        contents: Option<&str>,
    ) -> Result<ash_git::GitBlameLine, GitRuntimeError> {
        self.repository(repository_id)?
            .service
            .blame(path, line, ignore_whitespace, contents)
            .map_err(GitRuntimeError::Service)
    }
    pub(super) fn file_history_for(
        &self,
        repository_id: Option<&str>,
        path: &Path,
    ) -> Result<Vec<ash_git::GitFileHistoryItem>, GitRuntimeError> {
        self.repository(repository_id)?
            .service
            .file_history(path)
            .map_err(GitRuntimeError::Service)
    }

    pub(super) fn local_branches_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<Vec<GitBranchDto>, GitRuntimeError> {
        self.repository(repository_id)?.local_branches()
    }

    pub(super) fn catalog_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<ash_git::GitCatalog, GitRuntimeError> {
        let runtime = self.repository(repository_id)?;
        let _operation = lock_current_operation(&runtime.operation)
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        runtime.service.catalog().map_err(GitRuntimeError::Service)
    }

    pub(super) fn command_for(
        &self,
        repository_id: Option<&str>,
        command: &ash_git::GitCommand,
        cancellation: &CancellationToken,
    ) -> Result<
        (
            GitStatusResult,
            ash_git::GitCommandOutcome,
            Option<ash_git::GitIntegration>,
        ),
        GitRuntimeError,
    > {
        let runtime = self.repository(repository_id)?;
        let _operation = lock_operation_for_request(&runtime.operation, cancellation)
            .map_err(GitRuntimeError::Service)?;
        let outcome = runtime.service.command(command, cancellation);
        // A failed or cancelled Git invocation may already have written index or refs. Publish
        // its actual state before returning the failure so every renderer can inspect it.
        let (repository, snapshot) = match runtime.service.snapshot() {
            Ok(snapshot) => snapshot,
            Err(error) => {
                let _ = runtime.invalidate_graphs();
                return Err(GitRuntimeError::Service(error));
            }
        };
        let status = runtime.accept_status(repository, snapshot, StatusNotification::Always)?;
        let outcome = outcome.map_err(GitRuntimeError::Service)?;
        let operation = runtime
            .service
            .catalog()
            .map_err(GitRuntimeError::Service)?
            .operation;
        Ok((status, outcome, operation))
    }

    pub(super) fn index_diff_for(
        &self,
        repository_id: Option<&str>,
        path: &Path,
        comparison: ash_git::GitChangeFileComparison,
    ) -> Result<ash_git::GitIndexDiff, GitRuntimeError> {
        let runtime = self.repository(repository_id)?;
        let _operation = lock_current_operation(&runtime.operation)
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        runtime
            .service
            .index_diff(path, comparison)
            .map_err(GitRuntimeError::Service)
    }

    pub(super) fn index_edit_for(
        &self,
        repository_id: Option<&str>,
        request: &ash_git::GitIndexEdit,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.repository(repository_id)?
            .mutate_paths(|service| service.index_edit(request))
    }

    pub(super) fn create_branch_for(
        &self,
        repository_id: Option<&str>,
        name: &str,
    ) -> Result<Vec<GitBranchDto>, GitRuntimeError> {
        self.repository(repository_id)?.create_branch(name)
    }

    pub(super) fn delete_branch_for(
        &self,
        repository_id: Option<&str>,
        name: &str,
    ) -> Result<Vec<GitBranchDto>, GitRuntimeError> {
        self.repository(repository_id)?.delete_branch(name)
    }

    pub(super) fn mutable_source_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<PathBuf, GitRuntimeError> {
        let repository = self.repository(repository_id)?;
        repository
            .service
            .mutable_source()
            .map_err(GitRuntimeError::Service)
    }

    pub(super) fn readable_source_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<PathBuf, GitRuntimeError> {
        let repository = self.repository(repository_id)?;
        repository
            .service
            .readable_source()
            .map_err(GitRuntimeError::Service)
    }

    #[cfg(test)]
    pub(super) fn local_branches(&self) -> Result<Vec<GitBranchDto>, GitRuntimeError> {
        self.local_branches_for(None)
    }

    pub(super) fn recent_commits_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<Vec<GitCommitSummaryDto>, GitRuntimeError> {
        self.repository(repository_id)?.recent_commits()
    }

    #[cfg(test)]
    pub(super) fn recent_commits(&self) -> Result<Vec<GitCommitSummaryDto>, GitRuntimeError> {
        self.recent_commits_for(None)
    }

    pub(super) fn history_refs_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<GitHistoryRefsResult, GitRuntimeError> {
        self.repository(repository_id)?.history_refs()
    }

    pub(super) fn graph_for(
        &self,
        repository_id: Option<&str>,
        connection_id: u64,
        limit: std::num::NonZeroUsize,
        cursor: Option<&str>,
        revisions: Option<&[String]>,
    ) -> Result<GitGraphResult, GitRuntimeError> {
        self.repository(repository_id)?
            .graph(connection_id, limit, cursor, revisions)
    }

    #[cfg(test)]
    pub(super) fn graph(
        &self,
        connection_id: u64,
        limit: std::num::NonZeroUsize,
        cursor: Option<&str>,
    ) -> Result<GitGraphResult, GitRuntimeError> {
        self.graph_for(None, connection_id, limit, cursor, None)
    }

    pub(super) fn text_diff_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<GitTextDiffResult, GitRuntimeError> {
        self.repository(repository_id)?.text_diff()
    }

    #[cfg(test)]
    pub(super) fn text_diff(&self) -> Result<GitTextDiffResult, GitRuntimeError> {
        self.text_diff_for(None)
    }

    pub(super) fn commit_changes_for(
        &self,
        repository_id: Option<&str>,
        object_id: &str,
    ) -> Result<GitCommitChangesResult, GitRuntimeError> {
        self.repository(repository_id)?.commit_changes(object_id)
    }

    pub(super) fn compare_changes_for(
        &self,
        repository_id: Option<&str>,
        object_id: &str,
        base_reference: &str,
        mode: ash_git::GitComparisonMode,
    ) -> Result<GitCompareChangesResult, GitRuntimeError> {
        self.repository(repository_id)?
            .compare_changes(object_id, base_reference, mode)
    }

    pub(super) fn commit_message_for(
        &self,
        repository_id: Option<&str>,
        object_id: &str,
    ) -> Result<String, GitRuntimeError> {
        let repository = self.repository(repository_id)?;
        let _operation = repository
            .operation
            .lock()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        repository
            .service
            .commit_message(object_id)
            .map_err(GitRuntimeError::Service)
    }

    pub(super) fn commit_details_for(
        &self,
        repository_id: Option<&str>,
        object_id: &str,
    ) -> Result<ash_git::GitCommitDetails, GitRuntimeError> {
        let repository = self.repository(repository_id)?;
        let _operation = repository
            .operation
            .lock()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        repository
            .service
            .commit_details(object_id)
            .map_err(GitRuntimeError::Service)
    }

    pub(super) fn commit_file_for(
        &self,
        repository_id: Option<&str>,
        object_id: &str,
        path: &Path,
        comparison_base: Option<&str>,
    ) -> Result<GitCommitFileResult, GitRuntimeError> {
        self.repository(repository_id)?
            .commit_file(object_id, path, comparison_base)
    }

    pub(super) fn change_file_for(
        &self,
        repository_id: Option<&str>,
        path: &Path,
        comparison: GitChangeFileComparisonDto,
    ) -> Result<GitChangeFileResult, GitRuntimeError> {
        self.repository(repository_id)?
            .change_file(path, comparison)
    }

    pub(super) fn conflict_file_for(
        &self,
        repository_id: Option<&str>,
        path: &Path,
    ) -> Result<GitConflictFileResult, GitRuntimeError> {
        self.repository(repository_id)?.conflict_file(path)
    }

    pub(super) fn complete_conflict_for(
        &self,
        repository_id: Option<&str>,
        path: &Path,
        expected_stage_ids: [Option<String>; 3],
        expected_result_object_id: Option<String>,
        resolution: GitConflictResolutionDto,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.repository(repository_id)?.complete_conflict(
            path,
            expected_stage_ids,
            expected_result_object_id,
            resolution,
        )
    }

    pub(super) fn switch_branch_for(
        &self,
        repository_id: Option<&str>,
        name: &str,
        policy: ash_git::GitCheckoutPolicy,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.repository(repository_id)?.switch_branch(name, policy)
    }

    #[cfg(test)]
    pub(super) fn switch_branch(&self, name: &str) -> Result<GitStatusResult, GitRuntimeError> {
        self.switch_branch_for(None, name, ash_git::GitCheckoutPolicy::Keep)
    }

    pub(super) fn stage_for(
        &self,
        repository_id: Option<&str>,
        paths: Vec<PathBuf>,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.repository(repository_id)?.stage(paths)
    }

    #[cfg(test)]
    pub(super) fn stage(&self, paths: Vec<PathBuf>) -> Result<GitStatusResult, GitRuntimeError> {
        self.stage_for(None, paths)
    }

    pub(super) fn unstage_for(
        &self,
        repository_id: Option<&str>,
        paths: Vec<PathBuf>,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.repository(repository_id)?.unstage(paths)
    }

    pub(super) fn ai_contribution_for(
        &self,
        repository_id: Option<&str>,
        store: Option<&ash_state::SqliteTurnChangeStore>,
        scope: crate::git_service::GitCommitScope,
        editor_evidence: &[(PathBuf, String)],
    ) -> Result<(PathBuf, bool), GitRuntimeError> {
        let repository = self.repository(repository_id)?;
        let _operation = lock_current_operation(&repository.operation)
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let root = repository.identity.worktree_root().to_owned();
        let records = store
            .map(|store| store.list_for_worktree(&root))
            .transpose()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?
            .unwrap_or_default();
        let present = repository
            .service
            .has_ai_contribution(&records, scope, editor_evidence)
            .map_err(GitRuntimeError::Service)?;
        Ok((root, present))
    }
    pub(super) fn review_removal_for(
        &self,
        repository_id: Option<&str>,
        paths: Vec<PathBuf>,
    ) -> Result<crate::git_service::GitRemovalReview, GitRuntimeError> {
        let repository = self.repository(repository_id)?;
        let _operation = lock_current_operation(&repository.operation)
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        repository
            .service
            .review_removal(paths)
            .map_err(GitRuntimeError::Service)
    }
    pub(super) fn remove_files_for(
        &self,
        repository_id: Option<&str>,
        entries: Vec<ash_file_system::FileRemoval>,
        mode: ash_file_system::FileRemovalMode,
        expected_head: &ash_git::GitHead,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.repository(repository_id)?
            .mutate_paths(|service| service.remove_files(entries, mode, expected_head))
    }
    pub(super) fn discard_worktree_for(
        &self,
        repository_id: Option<&str>,
        paths: Vec<PathBuf>,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.repository(repository_id)?.discard_worktree(paths)
    }

    pub(super) fn commit_for(
        &self,
        repository_id: Option<&str>,
        request: ash_git::GitCommitRequest,
    ) -> Result<GitRuntimeCommit, GitRuntimeError> {
        self.repository(repository_id)?.commit(request)
    }

    pub(super) fn fetch_for(
        &self,
        repository_id: Option<&str>,
        mode: GitFetchModeDto,
        cancellation: &CancellationToken,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        match mode {
            GitFetchModeDto::Default => self.repository(repository_id)?.fetch_default(cancellation),
            GitFetchModeDto::All => self.repository(repository_id)?.fetch(cancellation),
            GitFetchModeDto::Remote(name) => self
                .repository(repository_id)?
                .fetch_remote(&name, cancellation),
        }
    }

    #[cfg(test)]
    pub(super) fn fetch(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.fetch_for(None, GitFetchModeDto::All, cancellation)
    }

    pub(super) fn pull_for(
        &self,
        repository_id: Option<&str>,
        mode: GitPullMode,
        cancellation: &CancellationToken,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.repository(repository_id)?.pull(mode, cancellation)
    }

    pub(super) fn push_for(
        &self,
        repository_id: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.repository(repository_id)?.push(cancellation)
    }

    pub(super) fn transport_for(
        &self,
        repository_id: Option<&str>,
        operation: crate::git_service::GitRemoteMutation<'_>,
        options: ash_git::GitTransportOptions,
        cancellation: &CancellationToken,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.repository(repository_id)?.mutate_remote(
            |service, cancellation| service.remote_with_options(operation, options, cancellation),
            cancellation,
        )
    }

    pub(super) fn close_connection(&self, connection_id: u64) {
        if self
            .discovery_interests
            .lock()
            .expect("Git discovery interests")
            .remove(&connection_id)
            .is_some()
        {
            let _ = self.reconcile();
        }
        for repository in self.repository_runtimes() {
            repository.close_connection(connection_id);
        }
    }

    pub(super) fn start_watching(
        self: &Arc<Self>,
        config: Option<Arc<ConfigStore>>,
        watch_dirs: Vec<Authorization>,
    ) -> GitWatcher {
        if watch_dirs.is_empty()
            || watch_dirs.iter().any(|proof| {
                proof.permission() != ash_file_access::Permission::WatchFiles
                    || proof.ensure_active().is_err()
            })
        {
            return GitWatcher::default();
        }
        let (ready, started) = mpsc::channel();
        let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel();
        let runtime = Arc::downgrade(self);
        let cancellation = CancellationSource::new();
        let token = cancellation.token();
        let thread = std::thread::Builder::new()
            .name("ash-git-discovery".into())
            .spawn(move || {
                watch_repositories(runtime, config, token, shutdown_rx, watch_dirs, ready)
            })
            .ok();
        if started.recv_timeout(Duration::from_secs(10)).is_err() {
            // This domain remains usable for explicit queries even if its optional watcher fails.
            log::warn!("Git discovery subscription did not become ready");
            cancellation.cancel();
        }
        GitWatcher {
            shutdown: Some(shutdown),
            thread,
            auto_fetch_shutdown: None,
            cancellation: Some(cancellation),
            children: Vec::new(),
        }
    }

    #[cfg(test)]
    fn watched_paths(&self) -> Vec<WatchPath> {
        self.repository_runtimes()
            .first()
            .map(|repository| repository.watched_paths())
            .unwrap_or_default()
    }

    fn watched_repositories(&self, watch_dirs: &[Authorization]) -> Vec<Arc<GitRepositoryRuntime>> {
        self.repository_runtimes()
            .into_iter()
            .filter(|repository| {
                watch_dirs.iter().any(|proof| {
                    proof.ensure_active().is_ok()
                        && proof.dir().id() == repository.service.dir().id()
                })
            })
            .collect()
    }

    fn discovery_paths(&self, watch_dirs: &[Authorization]) -> Vec<WatchPath> {
        let mut paths = self
            .dirs
            .iter()
            .filter(|(_, authorization)| {
                watch_dirs.iter().any(|proof| {
                    proof.ensure_active().is_ok() && proof.dir().id() == authorization.dir().id()
                })
            })
            .flat_map(|(_, authorization)| {
                [
                    WatchPath {
                        path: authorization.dir().requested_path().to_path_buf(),
                        recursive: true,
                    },
                    WatchPath {
                        path: authorization.dir().canonical_path().to_path_buf(),
                        recursive: true,
                    },
                ]
            })
            .collect::<Vec<_>>();
        // A directory grant can sit inside a checkout whose metadata is outside that grant.
        for runtime in self.watched_repositories(watch_dirs) {
            paths.extend(
                [runtime.identity.git_dir(), runtime.identity.common_dir()]
                    .into_iter()
                    .map(|path| WatchPath {
                        path: path.to_path_buf(),
                        recursive: true,
                    }),
            );
        }
        minimal_watch_paths(paths)
    }

    fn discovery_invalidated(&self, event: &FileWatcherEvent) -> bool {
        let FileWatcherEvent::PathsChanged { paths } = event else {
            return true;
        };
        let repositories = self.repository_runtimes();
        paths.iter().any(|path| {
            if path.file_name().is_some_and(|name| name == ".git") {
                return true;
            }
            if repositories.iter().any(|runtime| {
                path == runtime.identity.git_dir()
                    || path == runtime.identity.common_dir()
                    || runtime.service.dir_root().starts_with(path)
            }) {
                return true;
            }
            if repositories.iter().any(|runtime| {
                path.starts_with(runtime.identity.git_dir())
                    || path.starts_with(runtime.identity.common_dir())
            }) {
                return false;
            }
            path.is_dir()
                || path
                    .components()
                    .any(|component| component.as_os_str() == ".git")
        })
    }

    pub(super) fn common_dir_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<PathBuf, GitRuntimeError> {
        Ok(self.repository(repository_id)?.common_dir.clone())
    }

    fn repository(
        &self,
        repository_id: Option<&str>,
    ) -> Result<Arc<GitRepositoryRuntime>, GitRuntimeError> {
        let registry = self
            .registry
            .read()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        match repository_id {
            Some(id) => registry.repositories_by_id.get(id),
            None => registry.repositories.first(),
        }
        .cloned()
        .ok_or(GitRuntimeError::RepositoryNotFound)
    }
}

impl GitRepositoryRuntime {
    fn new(
        authorization: Authorization,
        projection_root: PathBuf,
        descriptor: GitRepositoryDto,
        updates: Arc<UpdateBroker>,
        cancellation: &CancellationToken,
    ) -> Result<Option<Self>, GitRuntimeError> {
        let service =
            GitService::new(authorization, projection_root).map_err(GitRuntimeError::Service)?;
        let Ok((repository, _)) = service.snapshot_for_request(cancellation) else {
            return Ok(None);
        };
        let ignore_watch_paths = service
            .ignore_watch_paths_for_request(&repository, cancellation)
            .map_err(GitRuntimeError::Service)?;
        Ok(Some(Self {
            operation: ash_git::repository_operation_lock(&repository),
            common_dir: dunce::simplified(repository.common_dir()).to_path_buf(),
            identity: repository,
            ignore_watch_paths: Mutex::new(ignore_watch_paths),
            service,
            descriptor,
            stream_instance_id: new_stream_instance_id()?,
            state: Mutex::new(GitRuntimeState {
                revision: 0,
                history_revision: 0,
                graph_revision: 0,
                graph_roots: Vec::new(),
                repository: None,
                status: None,
                references: None,
            }),
            graph_sessions: Mutex::new(HashMap::new()),
            next_graph_token: AtomicU64::new(1),
            updates,
        }))
    }

    fn status(&self) -> Result<GitStatusResult, GitRuntimeError> {
        let _operation = lock_current_operation(&self.operation)
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let (repository, snapshot) = self.service.snapshot().map_err(GitRuntimeError::Service)?;
        self.accept(repository, snapshot)
    }

    pub(super) fn local_branches(&self) -> Result<Vec<GitBranchDto>, GitRuntimeError> {
        let _operation = lock_current_operation(&self.operation)
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        self.local_branches_locked()
    }

    fn local_branches_locked(&self) -> Result<Vec<GitBranchDto>, GitRuntimeError> {
        self.service
            .local_branches()
            .map(|result| {
                let occupied = result.checked_out_elsewhere;
                let branches = result.branches;
                branches
                    .into_iter()
                    .map(|branch| GitBranchDto {
                        name: branch.name().into(),
                        object_id: branch.object_id().into(),
                        current: branch.is_current(),
                        upstream: branch.upstream().map(Into::into),
                        checked_out_elsewhere: Some(occupied.contains(branch.name())),
                    })
                    .collect()
            })
            .map_err(GitRuntimeError::Service)
    }

    fn create_branch(&self, name: &str) -> Result<Vec<GitBranchDto>, GitRuntimeError> {
        let _operation = lock_current_operation(&self.operation)
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        self.service
            .create_branch(name)
            .map_err(GitRuntimeError::Service)?;
        // Ref changes must refresh history in every connection even when HEAD and files are unchanged.
        let (repository, snapshot) = self.service.snapshot().map_err(GitRuntimeError::Service)?;
        self.accept_status(repository, snapshot, StatusNotification::Always)?;
        self.local_branches_locked()
    }

    fn delete_branch(&self, name: &str) -> Result<Vec<GitBranchDto>, GitRuntimeError> {
        let _operation = lock_current_operation(&self.operation)
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        self.service
            .delete_branch(name)
            .map_err(GitRuntimeError::Service)?;
        let (repository, snapshot) = self.service.snapshot().map_err(GitRuntimeError::Service)?;
        self.accept_status(repository, snapshot, StatusNotification::Always)?;
        self.local_branches_locked()
    }

    pub(super) fn recent_commits(&self) -> Result<Vec<GitCommitSummaryDto>, GitRuntimeError> {
        let _operation = lock_current_operation(&self.operation)
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        self.service
            .recent_commits()
            .map(|commits| {
                commits
                    .into_iter()
                    .map(|commit| GitCommitSummaryDto {
                        object_id: commit.object_id().into(),
                        parent_object_ids: commit.parent_object_ids().into(),
                        timestamp_seconds: commit.timestamp_seconds(),
                        subject: commit.subject().into(),
                    })
                    .collect()
            })
            .map_err(GitRuntimeError::Service)
    }

    fn history_refs(&self) -> Result<GitHistoryRefsResult, GitRuntimeError> {
        let _operation = lock_current_operation(&self.operation)
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let (repository, snapshot) = self.service.snapshot().map_err(GitRuntimeError::Service)?;
        let status = self.accept(repository, snapshot)?;
        let branches = self.local_branches_locked()?;
        let state = self
            .state
            .lock()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let references = state.references.as_ref().expect("accepted ref snapshot");
        Ok(GitHistoryRefsResult {
            status,
            graph_revision: state.graph_revision,
            references: project_references(&references.references),
            base_reference: references.base_reference.as_ref().map(project_reference),
            remotes: project_remotes(&references.remotes),
            branches,
        })
    }

    pub(super) fn graph(
        &self,
        connection_id: u64,
        limit: std::num::NonZeroUsize,
        cursor: Option<&str>,
        revisions: Option<&[String]>,
    ) -> Result<GitGraphResult, GitRuntimeError> {
        let _operation = lock_current_operation(&self.operation)
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        if cursor.is_none() {
            // A new traversal observes current refs and remotes. Accept that state
            // before saving its cursor so a delayed watcher cannot invalidate it
            // merely for reporting changes this traversal has already observed.
            let (repository, snapshot) =
                self.service.snapshot().map_err(GitRuntimeError::Service)?;
            self.accept(repository, snapshot)?;
        }
        let mut sessions = self
            .graph_sessions
            .lock()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let (graph, next_cursor) = match cursor {
            None => {
                sessions.remove(&connection_id);
                let mut graph_cursor = self
                    .service
                    .open_graph(revisions)
                    .map_err(GitRuntimeError::Service)?;
                let graph = self
                    .service
                    .graph_page(&mut graph_cursor, limit)
                    .map_err(GitRuntimeError::Service)?;
                if graph.has_more() {
                    let token = self.new_graph_token();
                    sessions.insert(
                        connection_id,
                        GraphSession {
                            token: token.clone(),
                            cursor: graph_cursor,
                            revisions: revisions.map(<[String]>::to_vec),
                        },
                    );
                    (graph, Some(token))
                } else {
                    (graph, None)
                }
            }
            Some(cursor) => {
                let session = sessions
                    .get_mut(&connection_id)
                    .filter(|session| {
                        session.token == cursor && session.revisions.as_deref() == revisions
                    })
                    .ok_or(GitRuntimeError::InvalidGraphCursor)?;
                let graph = self
                    .service
                    .graph_page(&mut session.cursor, limit)
                    .map_err(GitRuntimeError::Service)?;
                let has_more = graph.has_more();
                let next_cursor = session.token.clone();
                if !has_more {
                    sessions.remove(&connection_id);
                    (graph, None)
                } else {
                    (graph, Some(next_cursor))
                }
            }
        };
        let state = self
            .state
            .lock()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let status = state.status.as_ref().expect("accepted graph status");
        let references = state.references.as_ref().expect("accepted graph refs");
        let mut result = project_graph(graph, next_cursor, status, state.graph_revision);
        // A retained traversal owns commits, while decorations always come from the current snapshot.
        result.references = project_references(&references.references);
        result.remotes = project_remotes(&references.remotes);
        Ok(result)
    }

    pub(super) fn close_connection(&self, connection_id: u64) {
        if let Ok(mut sessions) = self.graph_sessions.lock() {
            sessions.remove(&connection_id);
        }
    }

    pub(super) fn text_diff(&self) -> Result<GitTextDiffResult, GitRuntimeError> {
        let _operation = lock_current_operation(&self.operation)
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let (repository, snapshot) = self
            .service
            .text_diff_snapshot()
            .map_err(GitRuntimeError::Service)?;
        let dir_prefix = self
            .service
            .dir_root()
            .strip_prefix(repository.worktree_root())
            .map_err(|_| GitRuntimeError::Boundary)?;
        let diffs = snapshot
            .diffs()
            .iter()
            .map(|diff| {
                let path = diff
                    .path()
                    .strip_prefix(dir_prefix)
                    .map_err(|_| GitRuntimeError::Boundary)?;
                let statistics = diff.statistics();
                Ok(GitTextDiffDto {
                    path: wire_path(path)?,
                    original: diff.original().into(),
                    modified: diff.modified().into(),
                    additions: statistics.additions(),
                    deletions: statistics.deletions(),
                })
            })
            .collect::<Result<Vec<_>, GitRuntimeError>>()?;
        let statistics = snapshot.statistics();
        let repository_snapshot = snapshot.repository().clone();
        let status = self.accept(repository, repository_snapshot)?;
        Ok(GitTextDiffResult {
            status,
            diffs,
            statistics: GitDiffStatisticsDto {
                files: statistics.files(),
                additions: statistics.additions(),
                deletions: statistics.deletions(),
            },
        })
    }

    pub(super) fn commit_changes(
        &self,
        object_id: &str,
    ) -> Result<GitCommitChangesResult, GitRuntimeError> {
        let _operation = lock_current_operation(&self.operation)
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let projected = self
            .service
            .commit_changes(object_id)
            .map_err(GitRuntimeError::Service)?;
        self.project_commit_changes(projected)
    }

    fn compare_changes(
        &self,
        object_id: &str,
        base_reference: &str,
        mode: ash_git::GitComparisonMode,
    ) -> Result<GitCompareChangesResult, GitRuntimeError> {
        let _operation = lock_current_operation(&self.operation)
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let projected = self
            .service
            .compare_changes(object_id, base_reference, mode)
            .map_err(GitRuntimeError::Service)?;
        let result = self.project_commit_changes(projected)?;
        Ok(GitCompareChangesResult {
            base_object_id: result
                .parent_object_id
                .expect("explicit comparisons always resolve a base"),
            changes: result.changes,
        })
    }

    fn project_commit_changes(
        &self,
        projected: crate::git_service::GitServiceCommitChanges,
    ) -> Result<GitCommitChangesResult, GitRuntimeError> {
        let dir_prefix = self
            .service
            .dir_root()
            .strip_prefix(projected.repository.worktree_root())
            .map_err(|_| GitRuntimeError::Boundary)?;
        let changes = projected
            .changes
            .iter()
            .filter_map(|change| dir_commit_change(change, dir_prefix))
            .collect::<Result<Vec<_>, GitRuntimeError>>()?;
        Ok(GitCommitChangesResult {
            parent_object_id: projected.parent_object_id,
            changes,
        })
    }

    pub(super) fn commit_file(
        &self,
        object_id: &str,
        path: &Path,
        comparison_base: Option<&str>,
    ) -> Result<GitCommitFileResult, GitRuntimeError> {
        let _operation = lock_current_operation(&self.operation)
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let file = self
            .service
            .commit_file(object_id, path, comparison_base)
            .map_err(GitRuntimeError::Service)?;
        Ok(GitCommitFileResult {
            original: commit_file_content(file.original()),
            modified: commit_file_content(file.modified()),
        })
    }

    pub(super) fn change_file(
        &self,
        path: &Path,
        comparison: GitChangeFileComparisonDto,
    ) -> Result<GitChangeFileResult, GitRuntimeError> {
        let _operation = lock_current_operation(&self.operation)
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let original_path = {
            let state = self
                .state
                .lock()
                .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
            let wire_path = wire_path(path)?;
            let change = state.status.as_ref().and_then(|status| {
                status
                    .changes
                    .iter()
                    .find(|change| change.path == wire_path)
            });
            change
                .map(|change| {
                    let status = match comparison {
                        GitChangeFileComparisonDto::Staged => change.index_status,
                        GitChangeFileComparisonDto::Unstaged => change.worktree_status,
                    };
                    match status {
                        GitChangeStatusDto::Unmodified => Ok(None),
                        GitChangeStatusDto::Renamed | GitChangeStatusDto::Copied => change
                            .original_path
                            .as_ref()
                            .map(|path| Some(PathBuf::from(path)))
                            .ok_or(GitRuntimeError::Boundary),
                        GitChangeStatusDto::Modified
                        | GitChangeStatusDto::Added
                        | GitChangeStatusDto::Deleted
                        | GitChangeStatusDto::TypeChanged
                        | GitChangeStatusDto::Unmerged
                        | GitChangeStatusDto::Untracked
                        | GitChangeStatusDto::Ignored => Ok(Some(path.to_path_buf())),
                    }
                })
                .transpose()?
                .flatten()
        };
        let comparison = match comparison {
            GitChangeFileComparisonDto::Staged => GitChangeFileComparison::Staged,
            GitChangeFileComparisonDto::Unstaged => GitChangeFileComparison::Unstaged,
        };
        // The published resource already identifies its comparison paths. Read fresh
        // contents without rescanning the repository on every preview selection.
        let file = match original_path {
            Some(original_path) => {
                self.service
                    .change_file_at_paths(&original_path, path, comparison)
            }
            None => self.service.change_file(path, comparison),
        }
        .map_err(GitRuntimeError::Service)?;
        Ok(GitChangeFileResult {
            original: commit_file_content(file.original()),
            modified: commit_file_content(file.modified()),
        })
    }

    pub(super) fn conflict_file(
        &self,
        path: &Path,
    ) -> Result<GitConflictFileResult, GitRuntimeError> {
        let _operation = lock_current_operation(&self.operation)
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let file = self
            .service
            .conflict_file(path)
            .map_err(GitRuntimeError::Service)?;
        Ok(GitConflictFileResult {
            stage_ids: file.stage_ids().clone(),
            result_object_id: file.result_object_id().map(str::to_owned),
            base: commit_file_content(file.base()),
            current: commit_file_content(file.current()),
            incoming: commit_file_content(file.incoming()),
            result: commit_file_content(file.result()),
        })
    }

    pub(super) fn complete_conflict(
        &self,
        path: &Path,
        expected_stage_ids: [Option<String>; 3],
        expected_result_object_id: Option<String>,
        resolution: GitConflictResolutionDto,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        let _operation = lock_current_operation(&self.operation)
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let resolution = match resolution {
            GitConflictResolutionDto::Edited { text } => {
                crate::git_service::GitConflictResolution::Edited(text)
            }
            GitConflictResolutionDto::Current => crate::git_service::GitConflictResolution::Current,
            GitConflictResolutionDto::Incoming => {
                crate::git_service::GitConflictResolution::Incoming
            }
        };
        let (repository, snapshot) = self
            .service
            .complete_conflict(
                path,
                expected_stage_ids,
                expected_result_object_id,
                resolution,
            )
            .map_err(GitRuntimeError::Service)?;
        self.accept(repository, snapshot)
    }

    pub(super) fn switch_branch(
        &self,
        name: &str,
        policy: ash_git::GitCheckoutPolicy,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.mutate_paths(|service| service.switch_branch(name, policy))
    }

    pub(super) fn stage(&self, paths: Vec<PathBuf>) -> Result<GitStatusResult, GitRuntimeError> {
        self.mutate_paths(|service| service.stage(paths))
    }

    pub(super) fn unstage(&self, paths: Vec<PathBuf>) -> Result<GitStatusResult, GitRuntimeError> {
        self.mutate_paths(|service| service.unstage(paths))
    }

    pub(super) fn discard_worktree(
        &self,
        paths: Vec<PathBuf>,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.mutate_paths(|service| service.discard_worktree(paths))
    }

    pub(super) fn commit(
        &self,
        request: ash_git::GitCommitRequest,
    ) -> Result<GitRuntimeCommit, GitRuntimeError> {
        let _operation = lock_current_operation(&self.operation)
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let committed = self.service.commit(request);
        let GitServiceCommit {
            object_id,
            repository,
            snapshot,
        } = match committed {
            Ok(committed) => committed,
            Err(error) => {
                // Staging can succeed before commit creation fails. Publish its state
                // without discarding history unless refs changed or cannot be observed.
                match self.service.snapshot() {
                    Ok((repository, snapshot)) => {
                        let _ = self.accept(repository, snapshot);
                    }
                    Err(_) => {
                        let _ = self.invalidate_graphs();
                    }
                }
                return Err(GitRuntimeError::Service(error));
            }
        };
        Ok(GitRuntimeCommit {
            object_id,
            status: self.accept(repository, snapshot)?,
        })
    }

    pub(super) fn fetch(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.mutate_remote(GitService::fetch, cancellation)
    }

    pub(super) fn fetch_default(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.mutate_remote(GitService::fetch_default, cancellation)
    }

    pub(super) fn fetch_remote(
        &self,
        name: &str,
        cancellation: &CancellationToken,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.mutate_remote(
            |service, cancellation| service.fetch_remote(name, cancellation),
            cancellation,
        )
    }

    pub(super) fn pull(
        &self,
        mode: GitPullMode,
        cancellation: &CancellationToken,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.mutate_remote(
            |service, cancellation| service.pull(mode, cancellation),
            cancellation,
        )
    }

    pub(super) fn push(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.mutate_remote(GitService::push, cancellation)
    }

    pub(super) fn start_watching(self: &Arc<Self>, parent: &CancellationToken) -> GitWatcher {
        let cancellation = parent.child_source();
        let token = cancellation.token();
        let (ready, started) = mpsc::channel();
        let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel();
        let runtime = Arc::downgrade(self);
        let thread = std::thread::Builder::new()
            .name("ash-git-watcher".into())
            .spawn(move || watch_git(runtime, shutdown_rx, token, ready))
            .ok();
        if thread.is_none() {
            return GitWatcher::default();
        }
        if started.recv_timeout(Duration::from_secs(10)).is_err() {
            log::warn!("Git repository subscription did not become ready");
            cancellation.cancel();
        }
        GitWatcher {
            shutdown: Some(shutdown),
            auto_fetch_shutdown: None,
            cancellation: Some(cancellation),
            thread,
            children: Vec::new(),
        }
    }

    fn start_autofetch(
        self: &Arc<Self>,
        config: Arc<ConfigStore>,
        parent: &CancellationToken,
    ) -> GitWatcher {
        let (shutdown, shutdown_rx) = mpsc::channel();
        let runtime = Arc::downgrade(self);
        let cancellation = parent.child_source();
        let token = cancellation.token();
        let thread = std::thread::Builder::new()
            .name("ash-git-autofetch".into())
            .spawn(move || run_autofetch(runtime, config, shutdown_rx, token))
            .expect("Git automatic-fetch worker starts");
        GitWatcher {
            shutdown: None,
            auto_fetch_shutdown: Some(shutdown),
            cancellation: Some(cancellation),
            thread: Some(thread),
            children: Vec::new(),
        }
    }

    fn mutate_paths(
        &self,
        operation: impl FnOnce(
            &GitService,
        )
            -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError>,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        let _operation = lock_current_operation(&self.operation)
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let (repository, snapshot) = operation(&self.service).map_err(GitRuntimeError::Service)?;
        self.accept(repository, snapshot)
    }

    fn mutate_remote(
        &self,
        operation: impl FnOnce(
            &GitService,
            &CancellationToken,
        )
            -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError>,
        cancellation: &CancellationToken,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        let _operation = lock_operation_for_request(&self.operation, cancellation)
            .map_err(GitRuntimeError::Service)?;
        let outcome = operation(&self.service, cancellation);
        let (repository, snapshot) = match outcome {
            Ok(snapshot) => snapshot,
            Err(error) => {
                // Failure can leave updated refs. Recovery shares the request's cancellation;
                // a cancelled fetch must not begin fresh queries while its watcher is stopping.
                match self.service.snapshot_for_request(cancellation) {
                    Ok((repository, snapshot)) => {
                        let _ = self.accept_status_for_request(
                            repository,
                            snapshot,
                            StatusNotification::Always,
                            cancellation,
                        );
                    }
                    Err(_) => {
                        let _ = self.invalidate_graphs();
                    }
                }
                return Err(GitRuntimeError::Service(error));
            }
        };
        self.accept_status_for_request(
            repository,
            snapshot,
            StatusNotification::Always,
            cancellation,
        )
    }

    fn accept(
        &self,
        repository: GitRepository,
        snapshot: GitRepositorySnapshot,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.accept_status(repository, snapshot, StatusNotification::OnChange)
    }

    fn accept_status(
        &self,
        repository: GitRepository,
        snapshot: GitRepositorySnapshot,
        notification: StatusNotification,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.accept_status_for_request(
            repository,
            snapshot,
            notification,
            &CancellationSource::new().token(),
        )
    }

    fn accept_status_for_request(
        &self,
        repository: GitRepository,
        snapshot: GitRepositorySnapshot,
        notification: StatusNotification,
        cancellation: &CancellationToken,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        let mut projected = project_status(
            self.descriptor.id.clone(),
            self.stream_instance_id.clone(),
            self.service.dir_root(),
            &repository,
            snapshot,
        )?;
        let references = self
            .service
            .reference_state_for_request(&repository, cancellation)
            .map_err(GitRuntimeError::Service)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let had_state = state.repository.is_some();
        let history_changed = state.repository.as_ref() != Some(&repository)
            || state.references.as_ref() != Some(&references)
            || state
                .status
                .as_ref()
                .is_none_or(|current| current.head != projected.head);
        let mut graph_roots = references
            .references
            .iter()
            .map(|reference| reference.object_id().to_owned())
            .collect::<Vec<_>>();
        match &projected.head {
            GitHeadDto::Branch { object_id, .. } | GitHeadDto::Detached { object_id } => {
                graph_roots.push(object_id.clone())
            }
            GitHeadDto::Unborn { .. } => {}
        }
        graph_roots.sort();
        graph_roots.dedup();
        // Pruned or non-commit objects cannot prove equivalence; invalidate conservatively.
        let graph_changed = state.repository.as_ref() != Some(&repository)
            || !self
                .service
                .same_graph_roots_for_request(
                    &repository,
                    &state.graph_roots,
                    &graph_roots,
                    cancellation,
                )
                .unwrap_or(false);
        cancellation
            .check()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Cancelled))?;
        let unchanged = !history_changed
            && state
                .status
                .as_ref()
                .is_some_and(|current| current.changes == projected.changes);
        if unchanged && matches!(notification, StatusNotification::OnChange) {
            projected.revision = state.revision;
            projected.history_revision = state.history_revision;
            return Ok(projected);
        }
        state.revision = state
            .revision
            .checked_add(1)
            .expect("Git status revision overflowed");
        projected.revision = state.revision;
        if history_changed {
            state.history_revision = state
                .history_revision
                .checked_add(1)
                .expect("Git history revision overflowed");
        }
        projected.history_revision = state.history_revision;
        if graph_changed {
            state.graph_revision = state
                .graph_revision
                .checked_add(1)
                .expect("Git graph revision overflowed");
        }
        state.graph_roots = graph_roots;
        state.repository = Some(repository);
        state.references = Some(references);
        state.status = Some(projected.clone());
        drop(state);
        if had_state && graph_changed {
            self.invalidate_graphs()?
        }
        self.updates.publish_git_status_changed(projected.clone());
        Ok(projected)
    }

    fn new_graph_token(&self) -> String {
        format!(
            "g{:x}",
            self.next_graph_token.fetch_add(1, Ordering::Relaxed)
        )
    }

    #[cfg(test)]
    fn refresh_from_watcher(&self) {
        self.refresh_from_watcher_for_request(&CancellationSource::new().token());
    }

    fn refresh_from_watcher_for_request(&self, cancellation: &CancellationToken) {
        let Ok(_operation) = lock_operation_for_request(&self.operation, cancellation) else {
            return;
        };
        let Ok((repository, snapshot)) = self.service.snapshot_for_request(cancellation) else {
            return;
        };
        let _ = self.accept_status_for_request(
            repository,
            snapshot,
            StatusNotification::OnChange,
            cancellation,
        );
    }

    #[cfg(test)]
    fn ignore_change(
        &self,
        event: &FileWatcherEvent,
    ) -> Result<Option<GitIgnoreChanged>, GitRuntimeError> {
        self.ignore_change_for_request(event, &CancellationSource::new().token())
    }

    fn ignore_change_for_request(
        &self,
        event: &FileWatcherEvent,
        cancellation: &CancellationToken,
    ) -> Result<Option<GitIgnoreChanged>, GitRuntimeError> {
        let root = self.service.dir_root();
        let mut affected = Vec::new();
        let mut all = matches!(event, FileWatcherEvent::RescanRequired { .. });
        let sources = self
            .ignore_watch_paths
            .lock()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?
            .clone();
        if let FileWatcherEvent::PathsChanged { paths } = event {
            for path in paths {
                // File events can use the user's workspace alias; query paths use its canonical root.
                let path = match path.strip_prefix(self.service.dir().requested_path()) {
                    Ok(relative) => self.service.dir().canonical_path().join(relative),
                    Err(_) => path.clone(),
                };
                if sources
                    .iter()
                    .any(|source| &path == source || source.starts_with(&path))
                {
                    all = true;
                    break;
                }
                if path.starts_with(self.identity.git_dir())
                    || path.starts_with(self.identity.common_dir())
                {
                    continue;
                }
                let scope = if path.file_name().is_some_and(|name| name == ".gitignore") {
                    path.parent().expect("ignore file has a parent")
                } else {
                    path.as_path()
                };
                if root.starts_with(scope) {
                    all = true;
                    break;
                }
                if let Ok(relative) = scope.strip_prefix(&root) {
                    affected.push(
                        relative
                            .to_str()
                            .ok_or(GitRuntimeError::Boundary)?
                            .replace('\\', "/"),
                    );
                }
            }
        }
        if all {
            let updated = self
                .service
                .ignore_watch_paths_for_request(&self.identity, cancellation)
                .map_err(GitRuntimeError::Service)?;
            *self
                .ignore_watch_paths
                .lock()
                .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))? = updated;
            affected.clear();
        } else if affected.is_empty() {
            return Ok(None);
        }
        affected.sort();
        affected.dedup();
        Ok(Some(GitIgnoreChanged {
            repository_id: self.descriptor.id.clone(),
            paths: affected,
        }))
    }

    fn invalidate_graphs(&self) -> Result<(), GitRuntimeError> {
        self.graph_sessions
            .lock()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?
            .clear();
        Ok(())
    }

    fn watched_paths(&self) -> Vec<WatchPath> {
        let mut paths = vec![
            WatchPath {
                path: self.service.dir().requested_path().to_path_buf(),
                recursive: true,
            },
            WatchPath {
                path: self.service.dir().canonical_path().to_path_buf(),
                recursive: true,
            },
        ];
        {
            let repository = &self.identity;
            paths.push(WatchPath {
                path: repository.git_dir().to_path_buf(),
                recursive: true,
            });
            paths.push(WatchPath {
                path: repository.common_dir().to_path_buf(),
                recursive: true,
            });
            let mut ancestor = self.service.dir_root().parent();
            while let Some(directory) = ancestor {
                if !directory.starts_with(repository.worktree_root()) {
                    break;
                }
                paths.push(WatchPath {
                    path: directory.join(".gitignore"),
                    recursive: false,
                });
                if directory == repository.worktree_root() {
                    break;
                }
                ancestor = directory.parent();
            }
        }
        paths.extend(
            self.ignore_watch_paths
                .lock()
                .expect("ignore watch paths poisoned")
                .iter()
                .cloned()
                .map(|path| WatchPath {
                    path,
                    recursive: false,
                }),
        );
        minimal_watch_paths(paths)
    }
}

fn minimal_watch_paths(mut paths: Vec<WatchPath>) -> Vec<WatchPath> {
    paths.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then(right.recursive.cmp(&left.recursive))
    });
    let mut watches: Vec<WatchPath> = Vec::new();
    for path in paths {
        // A recursive root already delivers descendant changes. Opening extra watches inside
        // a nested checkout keeps its child directories open and prevents Windows renames.
        if watches.iter().any(|parent| {
            parent == &path || (parent.recursive && path.path.starts_with(&parent.path))
        }) {
            continue;
        }
        watches.push(path);
    }
    watches
}

impl GitWatcher {
    fn signal_shutdown(&mut self) {
        if let Some(cancellation) = self.cancellation.take() {
            cancellation.cancel();
        }
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(shutdown) = self.auto_fetch_shutdown.take() {
            let _ = shutdown.send(());
        }
        // Refresh and autofetch share repository locks. Signal every child before joining any
        // of them, so a refresh cannot wait on an autofetch whose cancellation is still pending.
        for child in &mut self.children {
            child.signal_shutdown();
        }
    }
}

impl Drop for GitWatcher {
    fn drop(&mut self) {
        self.signal_shutdown();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.children.clear();
    }
}

fn run_autofetch(
    runtime: std::sync::Weak<GitRepositoryRuntime>,
    config: Arc<ConfigStore>,
    shutdown: mpsc::Receiver<()>,
    cancellation: CancellationToken,
) {
    let changes = config.subscribe_changes();
    let Ok(snapshot) = config.read_snapshot() else {
        log::warn!("Git automatic fetch could not read configuration");
        return;
    };
    let mut policy = snapshot.values.git;
    let mut due = Instant::now();
    loop {
        if shutdown.try_recv().is_ok() {
            return;
        }
        if policy.autofetch != GitAutoFetchMode::Off && Instant::now() >= due {
            let Some(repository) = runtime.upgrade() else {
                return;
            };
            let result = match policy.autofetch {
                GitAutoFetchMode::Default => repository.fetch_default(&cancellation),
                GitAutoFetchMode::All => repository.fetch(&cancellation),
                GitAutoFetchMode::Off => unreachable!(),
            };
            if cancellation.is_cancelled() {
                return;
            }
            if let Err(error) = result {
                log::warn!("Git automatic fetch failed: {error:?}");
            }
            due = Instant::now() + Duration::from_secs(u64::from(policy.autofetch_period));
        }
        let wait = if policy.autofetch == GitAutoFetchMode::Off {
            Duration::from_secs(1)
        } else {
            due.saturating_duration_since(Instant::now())
                .min(Duration::from_secs(1))
        };
        match changes.recv_timeout(wait) {
            Ok(_) => match config.read_snapshot() {
                Ok(snapshot) => {
                    let updated = snapshot.values.git;
                    if updated != policy {
                        policy = updated;
                        due = Instant::now();
                    }
                }
                Err(error) => {
                    log::warn!("Git automatic fetch could not reload configuration: {error}");
                    return;
                }
            },
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

fn watch_repositories(
    runtime: std::sync::Weak<GitRuntime>,
    config: Option<Arc<ConfigStore>>,
    cancellation: CancellationToken,
    mut shutdown: tokio::sync::oneshot::Receiver<()>,
    watch_dirs: Vec<Authorization>,
    ready: mpsc::Sender<()>,
) {
    let Some(runtime) = runtime.upgrade() else {
        return;
    };
    let Ok(executor) = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
    else {
        return;
    };
    let backend = if runtime.dirs.iter().all(|(_, authorization)| {
        authorization.dir().requested_path() == authorization.dir().canonical_path()
    }) {
        FileWatcherBackend::Recommended
    } else {
        FileWatcherBackend::Polling {
            interval: ALIASED_PATH_POLL_INTERVAL,
        }
    };
    let watcher = {
        let _entered = executor.enter();
        match FileWatcher::new_with_backend(backend) {
            Ok(watcher) => Arc::new(watcher),
            Err(error) => {
                log::warn!("Git discovery watcher failed: {error}");
                return;
            }
        }
    };
    let (subscriber, receiver) = watcher.add_subscriber();
    let mut paths = runtime.discovery_paths(&watch_dirs);
    let Ok(mut registration) = subscriber.register_paths(paths.clone()) else {
        return;
    };
    let mut receiver = DebouncedWatchReceiver::new(receiver, GIT_WATCH_DEBOUNCE);
    let mut children = HashMap::<String, (Arc<GitRepositoryRuntime>, GitWatcher)>::new();
    let mut ready = Some(ready);
    loop {
        if cancellation.is_cancelled() {
            break;
        }
        if let Err(error) = runtime.reconcile_with_notification(true, &cancellation) {
            log::warn!("Git repository discovery failed: {error:?}");
        }
        let repositories = runtime.watched_repositories(&watch_dirs);
        children.retain(|id, (owner, _)| {
            repositories
                .iter()
                .any(|repository| &repository.descriptor.id == id && Arc::ptr_eq(owner, repository))
        });
        for repository in repositories {
            children
                .entry(repository.descriptor.id.clone())
                .or_insert_with(|| {
                    let mut watches = vec![repository.start_watching(&cancellation)];
                    if repository.service.can_mutate()
                        && let Some(config) = &config
                    {
                        watches.push(repository.start_autofetch(Arc::clone(config), &cancellation));
                    }
                    let watcher = GitWatcher {
                        children: watches,
                        shutdown: None,
                        thread: None,
                        auto_fetch_shutdown: None,
                        cancellation: None,
                    };
                    (repository, watcher)
                });
        }
        if let Some(ready) = ready.take() {
            let _ = ready.send(());
        }
        let next_paths = runtime.discovery_paths(&watch_dirs);
        if next_paths != paths {
            match subscriber.register_paths(next_paths.clone()) {
                Ok(next) => {
                    registration = next;
                    paths = next_paths;
                }
                Err(error) => {
                    log::warn!("Git discovery watch registration failed: {error}");
                    break;
                }
            }
        }
        // Repository owners contain Tokio runtimes. Reconcile and dispose them on this thread,
        // outside `block_on`, including when a removed repository loses its final reference.
        let changed = loop {
            let event = executor.block_on(async {
                tokio::select! {
                    _ = &mut shutdown => None,
                    event = receiver.recv() => event,
                }
            });
            match event {
                Some(event) if runtime.discovery_invalidated(&event) => break true,
                Some(_) => {}
                None => break false,
            }
        };
        if !changed {
            break;
        }
    }
    drop(registration);
    drop(children);
}

fn watch_git(
    runtime: std::sync::Weak<GitRepositoryRuntime>,
    mut shutdown: tokio::sync::oneshot::Receiver<()>,
    cancellation: CancellationToken,
    ready: mpsc::Sender<()>,
) {
    // Keep the final strong reference on the watcher thread stack. `GitService` owns a Tokio
    // runtime, which must not be dropped from inside the async block when the parent runtime is
    // retired concurrently.
    let Some(_runtime_lifetime) = runtime.upgrade() else {
        return;
    };
    let Ok(tokio_runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
    else {
        return;
    };
    tokio_runtime.block_on(async move {
        let Some(git_runtime) = runtime.upgrade() else {
            return;
        };
        let backend = if git_runtime.service.dir().requested_path()
            == git_runtime.service.dir().canonical_path()
        {
            FileWatcherBackend::Recommended
        } else {
            FileWatcherBackend::Polling {
                interval: ALIASED_PATH_POLL_INTERVAL,
            }
        };
        let Ok(file_watcher) = FileWatcher::new_with_backend(backend) else {
            return;
        };
        let file_watcher = Arc::new(file_watcher);
        let (subscriber, receiver) = file_watcher.add_subscriber();
        let mut watched_paths = git_runtime.watched_paths();
        let Ok(mut registration) = subscriber.register_paths(watched_paths.clone()) else {
            return;
        };
        let _ = ready.send(());
        // Re-read sources after registering so startup config changes cannot leave missing watches.
        let mut initial = Some(FileWatcherEvent::RescanRequired {
            watched_paths: watched_paths
                .iter()
                .map(|watch| watch.path.clone())
                .collect(),
        });
        drop(git_runtime);
        let mut receiver = DebouncedWatchReceiver::new(receiver, GIT_WATCH_DEBOUNCE);
        loop {
            if cancellation.is_cancelled() {
                break;
            }
            let event = if let Some(event) = initial.take() {
                event
            } else {
                tokio::select! {
                _ = cancellation.cancelled() => break,
                _ = &mut shutdown => break,
                event = receiver.recv() => {
                    let Some(event) = event else {
                        break;
                    };
                    event
                }
                }
            };
            let Some(git_runtime) = runtime.upgrade() else {
                break;
            };
            let refresh_runtime = Arc::clone(&git_runtime);
            let request_cancellation = cancellation.clone();
            let change = match tokio::task::spawn_blocking(move || {
                refresh_runtime.ignore_change_for_request(&event, &request_cancellation)
            })
            .await
            {
                Ok(Ok(change)) => change,
                error => {
                    log::warn!("Unable to refresh Git ignore rules: {error:?}");
                    continue;
                }
            };
            let next_paths = git_runtime.watched_paths();
            if next_paths != watched_paths {
                match subscriber.register_paths(next_paths.clone()) {
                    Ok(next_registration) => {
                        registration = next_registration;
                        watched_paths = next_paths;
                    }
                    Err(error) => {
                        log::warn!("Unable to register Git ignore watches: {error}");
                        break;
                    }
                }
            }
            // Consumers can edit a newly selected excludesFile as soon as they receive this hint.
            if let Some(change) = change {
                git_runtime.updates.publish_git_ignore_changed(change);
            }
            let request_cancellation = cancellation.clone();
            let _ = tokio::task::spawn_blocking(move || {
                git_runtime.refresh_from_watcher_for_request(&request_cancellation)
            })
            .await;
        }
        drop(registration);
    });
}

fn discover_repository_roots(
    authorization: &Authorization,
    options: &GitDiscoveryOptions,
) -> Vec<PathBuf> {
    const MAX_REPOSITORIES: usize = 512;
    let dir_root = authorization.dir().canonical_path();
    let mut candidates = vec![dir_root.to_path_buf()];
    let mut builder = WalkBuilder::new(dir_root);
    let ignored = options.ignored_folders.clone();
    builder
        .hidden(false)
        .follow_links(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .parents(false)
        .max_depth(if options.max_depth < 0 {
            None
        } else {
            Some(options.max_depth as usize)
        })
        .filter_entry(move |entry| {
            entry.depth() == 0
                || entry.file_name() != ".git"
                    && !ignored
                        .iter()
                        .any(|name| entry.file_name() == name.as_str())
        });
    for entry in builder.build().filter_map(Result::ok) {
        if entry.file_type().is_some_and(|kind| kind.is_dir()) && entry.path().join(".git").exists()
        {
            candidates.push(entry.path().to_path_buf());
        }
        if candidates.len() >= MAX_REPOSITORIES {
            break;
        }
    }
    let mut explicit_roots = std::collections::BTreeSet::new();
    for path in &options.scan_repositories {
        let path = Path::new(path);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            dir_root.join(path)
        };
        if let Ok(path) = dunce::canonicalize(path) {
            if path.starts_with(dir_root) && path.is_dir() {
                explicit_roots.insert(path.clone());
                candidates.push(path);
            }
        }
    }
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return vec![];
    };
    let client = crate::git_service::current_client();
    let mut candidates = std::collections::VecDeque::from(candidates);
    let mut roots = vec![];
    let mut submodules = 0;
    let mut worktrees = 0;
    while let Some(candidate) = candidates.pop_front() {
        let Ok(repository) = runtime.block_on(client.open_repository(&candidate)) else {
            continue;
        };
        let root = if repository.worktree_root().starts_with(dir_root) {
            repository.worktree_root().to_path_buf()
        } else {
            candidate.clone()
        };
        if roots.contains(&root) {
            continue;
        }
        if root != dir_root
            && !explicit_roots.contains(&root)
            && repository.kind() == ash_git::GitRepositoryKind::LinkedWorktree
        {
            if !options.detect_worktrees || worktrees >= options.worktree_limit {
                continue;
            }
            worktrees += 1;
        }
        if root != dir_root
            && repository.worktree_root().join(".git").is_file()
            && repository.kind() == ash_git::GitRepositoryKind::Standard
            && runtime
                .block_on(client.is_submodule(&repository))
                .unwrap_or(false)
        {
            if !options.detect_submodules || submodules >= options.submodule_limit {
                continue;
            }
            submodules += 1;
        }
        roots.push(root);
        if options.detect_submodules {
            for path in runtime
                .block_on(client.submodule_paths(&repository))
                .unwrap_or_default()
            {
                if submodules >= options.submodule_limit {
                    break;
                }
                if let Ok(path) = dunce::canonicalize(repository.worktree_root().join(path)) {
                    if path.starts_with(dir_root) && path.join(".git").exists() {
                        candidates.push_back(path);
                    }
                }
            }
        }
        if options.detect_worktrees {
            for worktree in runtime
                .block_on(client.worktrees(&repository))
                .unwrap_or_default()
            {
                if worktrees >= options.worktree_limit {
                    break;
                }
                if worktree.checkout_root().starts_with(dir_root)
                    && worktree.checkout_root() != repository.worktree_root()
                {
                    candidates.push_back(worktree.checkout_root().to_path_buf());
                }
            }
        }
        if roots.len() >= MAX_REPOSITORIES {
            break;
        }
    }
    roots.sort();
    roots.dedup();
    roots.truncate(MAX_REPOSITORIES);
    roots
}

fn repository_descriptor(
    dir_id: Option<String>,
    authorization: &Authorization,
    projection_root: &Path,
) -> Result<GitRepositoryDto, GitRuntimeError> {
    let relative = projection_root
        .strip_prefix(authorization.dir().canonical_path())
        .map_err(|_| GitRuntimeError::Boundary)?;
    let path = wire_path(relative)?;
    let label = projection_root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Repository")
        .to_string();
    let mut identity = authorization
        .dir()
        .canonical_path()
        .as_os_str()
        .as_encoded_bytes()
        .to_vec();
    identity.push(0);
    identity.extend_from_slice(if path.is_empty() {
        b"."
    } else {
        path.as_bytes()
    });
    let digest = Sha256::digest(identity);
    let id = format!("repo_{:x}", digest);
    Ok(GitRepositoryDto {
        parent_path: None,
        id,
        label,
        path,
        dir_id,
    })
}

fn project_graph(
    graph: GitGraph,
    next_cursor: Option<String>,
    status: &GitStatusResult,
    graph_revision: u64,
) -> GitGraphResult {
    GitGraphResult {
        stream_instance_id: status.stream_instance_id.clone(),
        history_revision: status.history_revision,
        graph_revision,
        commits: graph
            .commits()
            .iter()
            .map(|commit| GitCommitSummaryDto {
                object_id: commit.object_id().into(),
                parent_object_ids: commit.parent_object_ids().into(),
                timestamp_seconds: commit.timestamp_seconds(),
                subject: commit.subject().into(),
            })
            .collect(),
        references: project_references(graph.references()),
        remotes: project_remotes(graph.remotes()),
        has_more: graph.has_more(),
        next_cursor,
    }
}

fn project_reference(reference: &ash_git::GitReference) -> GitReferenceDto {
    GitReferenceDto {
        name: reference.name().into(),
        object_id: reference.object_id().into(),
        kind: match reference.kind() {
            GitReferenceKind::LocalBranch => GitReferenceKindDto::LocalBranch,
            GitReferenceKind::RemoteBranch => GitReferenceKindDto::RemoteBranch,
            GitReferenceKind::Tag => GitReferenceKindDto::Tag,
        },
        remote_name: reference.remote_name().map(Into::into),
        current: reference.is_current(),
    }
}

fn project_references(references: &[ash_git::GitReference]) -> Vec<GitReferenceDto> {
    references.iter().map(project_reference).collect()
}

fn project_remotes(remotes: &[ash_git::GitRemote]) -> Vec<GitRemoteDto> {
    remotes
        .iter()
        .map(|remote| GitRemoteDto {
            name: remote.name().into(),
            identity: remote.identity().map(|identity| GitRepositoryIdentityDto {
                provider: match identity.provider() {
                    GitRemoteProvider::Github => GitRemoteProviderDto::Github,
                    GitRemoteProvider::Gitlab => GitRemoteProviderDto::Gitlab,
                    GitRemoteProvider::Bitbucket => GitRemoteProviderDto::Bitbucket,
                    GitRemoteProvider::Other => GitRemoteProviderDto::Other,
                },
                host: identity.host().into(),
                owner: identity.owner().into(),
                repository: identity.repository().into(),
            }),
        })
        .collect()
}

fn project_status(
    repository_id: String,
    stream_instance_id: StreamInstanceId,
    dir_root: &Path,
    repository: &GitRepository,
    snapshot: GitRepositorySnapshot,
) -> Result<GitStatusResult, GitRuntimeError> {
    let dir_prefix = dir_root
        .strip_prefix(repository.worktree_root())
        .map_err(|_| GitRuntimeError::Boundary)?;
    Ok(GitStatusResult {
        repository_id,
        stream_instance_id,
        revision: 0,
        history_revision: 0,
        path: wire_path(dir_prefix)?,
        head: head(snapshot.head()),
        changes: snapshot
            .changes()
            .iter()
            .filter_map(|change| dir_change(change, dir_prefix))
            .collect::<Result<_, _>>()?,
    })
}

fn new_stream_instance_id() -> Result<StreamInstanceId, GitRuntimeError> {
    use std::fmt::Write as _;

    let mut random = [0_u8; 16];
    getrandom::getrandom(&mut random)
        .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
    let mut value = String::with_capacity("git_".len() + random.len() * 2);
    value.push_str("git_");
    for byte in random {
        write!(value, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(StreamInstanceId::new(value).expect("generated Git stream instance ID is non-empty"))
}

pub(super) fn head(head: &GitHead) -> GitHeadDto {
    match head {
        GitHead::Branch {
            name,
            object_id,
            upstream,
        } => GitHeadDto::Branch {
            name: name.clone(),
            object_id: object_id.clone(),
            upstream: upstream.as_ref().map(|upstream| GitUpstreamDto {
                name: upstream.name().into(),
                ahead: upstream.ahead(),
                behind: upstream.behind(),
            }),
        },
        GitHead::Detached { object_id } => GitHeadDto::Detached {
            object_id: object_id.clone(),
        },
        GitHead::Unborn { name } => GitHeadDto::Unborn { name: name.clone() },
    }
}

fn dir_change(
    change: &GitRepositoryChange,
    dir_prefix: &Path,
) -> Option<Result<GitRepositoryChangeDto, GitRuntimeError>> {
    let path = change.path().strip_prefix(dir_prefix).ok()?;
    Some((|| {
        Ok(GitRepositoryChangeDto {
            path: wire_path(path)?,
            original_path: change
                .original_path()
                .and_then(|path| path.strip_prefix(dir_prefix).ok())
                .map(wire_path)
                .transpose()?,
            index_status: change_status(change.index_status()),
            worktree_status: change_status(change.worktree_status()),
            conflicted: change.is_conflicted(),
            submodule: submodule(change.submodule()),
        })
    })())
}

fn dir_commit_change(
    change: &GitCommitChange,
    dir_prefix: &Path,
) -> Option<Result<GitCommitChangeDto, GitRuntimeError>> {
    let path = change.path().strip_prefix(dir_prefix).ok()?;
    Some((|| {
        Ok(GitCommitChangeDto {
            path: wire_path(path)?,
            original_path: change
                .original_path()
                .and_then(|path| path.strip_prefix(dir_prefix).ok())
                .map(wire_path)
                .transpose()?,
            status: change_status(change.status()),
        })
    })())
}

fn change_status(status: GitChangeStatus) -> GitChangeStatusDto {
    match status {
        GitChangeStatus::Unmodified => GitChangeStatusDto::Unmodified,
        GitChangeStatus::Modified => GitChangeStatusDto::Modified,
        GitChangeStatus::Added => GitChangeStatusDto::Added,
        GitChangeStatus::Deleted => GitChangeStatusDto::Deleted,
        GitChangeStatus::Renamed => GitChangeStatusDto::Renamed,
        GitChangeStatus::Copied => GitChangeStatusDto::Copied,
        GitChangeStatus::TypeChanged => GitChangeStatusDto::TypeChanged,
        GitChangeStatus::Unmerged => GitChangeStatusDto::Unmerged,
        GitChangeStatus::Untracked => GitChangeStatusDto::Untracked,
        GitChangeStatus::Ignored => GitChangeStatusDto::Ignored,
    }
}

fn commit_file_content(content: Option<&[u8]>) -> GitCommitFileContentDto {
    match content {
        None => GitCommitFileContentDto::Missing,
        Some(content) if content.contains(&0) => GitCommitFileContentDto::Binary {
            data: Some(base64::engine::general_purpose::STANDARD.encode(content)),
        },
        Some(content) => match std::str::from_utf8(content) {
            Ok(text) => GitCommitFileContentDto::Text { text: text.into() },
            Err(_) => GitCommitFileContentDto::Binary {
                data: Some(base64::engine::general_purpose::STANDARD.encode(content)),
            },
        },
    }
}

fn submodule(state: ash_git::GitSubmoduleState) -> GitSubmoduleStateDto {
    GitSubmoduleStateDto {
        is_submodule: state.is_submodule(),
        commit_changed: state.commit_changed(),
        tracked_changes: state.tracked_changes(),
        untracked_changes: state.untracked_changes(),
    }
}

fn wire_path(path: &Path) -> Result<String, GitRuntimeError> {
    path.to_str()
        .map(|path| path.replace('\\', "/"))
        .ok_or(GitRuntimeError::Boundary)
}

#[cfg(test)]
#[path = "git_runtime_tests.rs"]
mod tests;

fn lock_operation_for_request<'a>(
    lock: &'a ash_git::RepositoryOperationLock,
    cancellation: &CancellationToken,
) -> Result<ash_git::RepositoryOperationGuard<'a>, GitServiceError> {
    loop {
        cancellation
            .check()
            .map_err(|_| GitServiceError::Cancelled)?;
        match lock.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return Err(GitServiceError::Runtime),
        }
    }
}

fn lock_current_operation(
    lock: &ash_git::RepositoryOperationLock,
) -> Result<ash_git::RepositoryOperationGuard<'_>, GitServiceError> {
    if let Some(token) = crate::git_service::invocation_cancellation() {
        loop {
            token.check().map_err(|_| GitServiceError::Cancelled)?;
            let result = lock.try_lock();
            match result {
                Ok(guard) => return Ok(guard),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(_) => return Err(GitServiceError::Runtime),
            }
        }
    }
    lock.lock().map_err(|_| GitServiceError::Runtime)
}
