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
use ash_app_server_protocol::protocol::git::GitDiffStatisticsDto;
use ash_app_server_protocol::protocol::git::GitFetchModeDto;
use ash_app_server_protocol::protocol::git::GitGraphResult;
use ash_app_server_protocol::protocol::git::GitHeadDto;
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
use ash_config::ConfigStore;
use ash_config::GitAutoFetchMode;
use ash_file_access::Authorization;
use ash_file_watcher::DebouncedWatchReceiver;
use ash_file_watcher::FileWatcher;
use ash_file_watcher::FileWatcherBackend;
use ash_file_watcher::WatchPath;
use ash_git::GitChangeFileComparison;
use ash_git::GitChangeStatus;
use ash_git::GitCommitChange;
use ash_git::GitGraph;
use ash_git::GitGraphCursor;
use ash_git::GitHead;
use ash_git::GitReferenceKind;
use ash_git::GitRemoteProvider;
use ash_git::GitRepository;
use ash_git::GitRepositoryChange;
use ash_git::GitRepositorySnapshot;
use ash_protocol::StreamInstanceId;
use ignore::WalkBuilder;
use sha2::Digest;
use sha2::Sha256;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;
use std::time::Instant;

const GIT_WATCH_DEBOUNCE: Duration = Duration::from_millis(100);
const ALIASED_PATH_POLL_INTERVAL: Duration = Duration::from_millis(100);

pub(crate) struct GitRuntime {
    repositories: Vec<Arc<GitRepositoryRuntime>>,
    repositories_by_id: HashMap<String, Arc<GitRepositoryRuntime>>,
}

struct GitRepositoryRuntime {
    descriptor: GitRepositoryDto,
    service: GitService,
    stream_instance_id: StreamInstanceId,
    operation: Arc<Mutex<()>>,
    state: Mutex<GitRuntimeState>,
    graph_sessions: Mutex<HashMap<u64, GraphSession>>,
    next_graph_token: AtomicU64,
    updates: Arc<UpdateBroker>,
}

#[derive(Default)]
pub(super) struct GitWatcher {
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    auto_fetch_shutdown: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
    children: Vec<GitWatcher>,
}

struct GitRuntimeState {
    revision: u64,
    repository: Option<GitRepository>,
    status: Option<GitStatusResult>,
}

struct GraphSession {
    token: String,
    cursor: GitGraphCursor,
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

// Unscoped delegates keep the in-process API backward compatible for tests and embedders; RPC
// dispatch uses the explicit `*_for` methods so concurrent clients never share active state.
#[allow(dead_code)]
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
        let mut repositories = Vec::new();
        let mut repositories_by_id = HashMap::new();
        let mut worktrees = Vec::<PathBuf>::new();
        for (dir_id, authorization) in dirs {
            for projection_root in discover_repository_roots(&authorization) {
                let descriptor =
                    repository_descriptor(dir_id.clone(), &authorization, &projection_root)?;
                let Some(runtime) = GitRepositoryRuntime::new(
                    authorization.clone(),
                    projection_root,
                    descriptor,
                    Arc::clone(&updates),
                )?
                else {
                    continue;
                };
                let runtime = Arc::new(runtime);
                let Ok((repository, _)) = runtime.service.snapshot() else {
                    continue;
                };
                if worktrees
                    .iter()
                    .any(|root| root == repository.worktree_root())
                {
                    continue;
                }
                worktrees.push(repository.worktree_root().to_path_buf());
                repositories_by_id.insert(runtime.descriptor.id.clone(), Arc::clone(&runtime));
                repositories.push(runtime);
            }
        }
        repositories.sort_by(|left, right| {
            let left_order = left
                .descriptor
                .dir_id
                .as_ref()
                .and_then(|id| dir_order.get(id))
                .copied()
                .unwrap_or(usize::MAX);
            let right_order = right
                .descriptor
                .dir_id
                .as_ref()
                .and_then(|id| dir_order.get(id))
                .copied()
                .unwrap_or(usize::MAX);
            left_order
                .cmp(&right_order)
                .then(left.descriptor.path.cmp(&right.descriptor.path))
        });
        Ok(Arc::new(Self {
            repositories,
            repositories_by_id,
        }))
    }

    pub(super) fn repositories(&self) -> GitRepositoriesResult {
        GitRepositoriesResult {
            repositories: self
                .repositories
                .iter()
                .map(|runtime| runtime.descriptor.clone())
                .collect(),
        }
    }

    pub(super) fn status_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.repository(repository_id)?.status()
    }

    pub(super) fn status(&self) -> Result<GitStatusResult, GitRuntimeError> {
        self.status_for(None)
    }

    pub(super) fn local_branches_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<Vec<GitBranchDto>, GitRuntimeError> {
        self.repository(repository_id)?.local_branches()
    }

    pub(super) fn create_branch_for(
        &self,
        repository_id: Option<&str>,
        name: &str,
    ) -> Result<Vec<GitBranchDto>, GitRuntimeError> {
        self.repository(repository_id)?.create_branch(name)
    }

    pub(super) fn local_branches(&self) -> Result<Vec<GitBranchDto>, GitRuntimeError> {
        self.local_branches_for(None)
    }

    pub(super) fn recent_commits_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<Vec<GitCommitSummaryDto>, GitRuntimeError> {
        self.repository(repository_id)?.recent_commits()
    }

    pub(super) fn recent_commits(&self) -> Result<Vec<GitCommitSummaryDto>, GitRuntimeError> {
        self.recent_commits_for(None)
    }

    pub(super) fn graph_for(
        &self,
        repository_id: Option<&str>,
        connection_id: u64,
        limit: std::num::NonZeroUsize,
        cursor: Option<&str>,
    ) -> Result<GitGraphResult, GitRuntimeError> {
        self.repository(repository_id)?
            .graph(connection_id, limit, cursor)
    }

    pub(super) fn graph(
        &self,
        connection_id: u64,
        limit: std::num::NonZeroUsize,
        cursor: Option<&str>,
    ) -> Result<GitGraphResult, GitRuntimeError> {
        self.graph_for(None, connection_id, limit, cursor)
    }

    pub(super) fn text_diff_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<GitTextDiffResult, GitRuntimeError> {
        self.repository(repository_id)?.text_diff()
    }

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

    pub(super) fn commit_changes(
        &self,
        object_id: &str,
    ) -> Result<GitCommitChangesResult, GitRuntimeError> {
        self.commit_changes_for(None, object_id)
    }

    pub(super) fn commit_file_for(
        &self,
        repository_id: Option<&str>,
        object_id: &str,
        path: &Path,
    ) -> Result<GitCommitFileResult, GitRuntimeError> {
        self.repository(repository_id)?.commit_file(object_id, path)
    }

    pub(super) fn commit_file(
        &self,
        object_id: &str,
        path: &Path,
    ) -> Result<GitCommitFileResult, GitRuntimeError> {
        self.commit_file_for(None, object_id, path)
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

    pub(super) fn change_file(
        &self,
        path: &Path,
        comparison: GitChangeFileComparisonDto,
    ) -> Result<GitChangeFileResult, GitRuntimeError> {
        self.change_file_for(None, path, comparison)
    }

    pub(super) fn switch_branch_for(
        &self,
        repository_id: Option<&str>,
        name: &str,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.repository(repository_id)?.switch_branch(name)
    }

    pub(super) fn switch_branch(&self, name: &str) -> Result<GitStatusResult, GitRuntimeError> {
        self.switch_branch_for(None, name)
    }

    pub(super) fn stage_for(
        &self,
        repository_id: Option<&str>,
        paths: Vec<PathBuf>,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.repository(repository_id)?.stage(paths)
    }

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

    pub(super) fn unstage(&self, paths: Vec<PathBuf>) -> Result<GitStatusResult, GitRuntimeError> {
        self.unstage_for(None, paths)
    }

    pub(super) fn discard_worktree_for(
        &self,
        repository_id: Option<&str>,
        paths: Vec<PathBuf>,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.repository(repository_id)?.discard_worktree(paths)
    }

    pub(super) fn discard_worktree(
        &self,
        paths: Vec<PathBuf>,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.discard_worktree_for(None, paths)
    }

    pub(super) fn commit_for(
        &self,
        repository_id: Option<&str>,
        message: String,
    ) -> Result<GitRuntimeCommit, GitRuntimeError> {
        self.repository(repository_id)?.commit(message)
    }

    pub(super) fn commit(&self, message: String) -> Result<GitRuntimeCommit, GitRuntimeError> {
        self.commit_for(None, message)
    }

    pub(super) fn fetch_for(
        &self,
        repository_id: Option<&str>,
        mode: GitFetchModeDto,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        match mode {
            GitFetchModeDto::Default => self.repository(repository_id)?.fetch_default(),
            GitFetchModeDto::All => self.repository(repository_id)?.fetch(),
        }
    }

    pub(super) fn fetch(&self) -> Result<GitStatusResult, GitRuntimeError> {
        self.fetch_for(None, GitFetchModeDto::All)
    }

    pub(super) fn pull_fast_forward_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.repository(repository_id)?.pull_fast_forward()
    }

    pub(super) fn pull_fast_forward(&self) -> Result<GitStatusResult, GitRuntimeError> {
        self.pull_fast_forward_for(None)
    }

    pub(super) fn push_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        self.repository(repository_id)?.push()
    }

    pub(super) fn push(&self) -> Result<GitStatusResult, GitRuntimeError> {
        self.push_for(None)
    }

    pub(super) fn close_connection(&self, connection_id: u64) {
        for repository in &self.repositories {
            repository.close_connection(connection_id);
        }
    }

    pub(super) fn start_watching(self: &Arc<Self>, config: Option<Arc<ConfigStore>>) -> GitWatcher {
        let mut children = self
            .repositories
            .iter()
            .map(GitRepositoryRuntime::start_watching)
            .collect::<Vec<_>>();
        if let Some(config) = config {
            children.extend(
                self.repositories
                    .iter()
                    .filter(|repository| repository.service.can_mutate())
                    .map(|repository| repository.start_autofetch(Arc::clone(&config))),
            );
        }
        GitWatcher {
            shutdown: None,
            auto_fetch_shutdown: None,
            thread: None,
            children,
        }
    }

    fn watched_paths(&self) -> Vec<WatchPath> {
        self.repositories
            .first()
            .map(|repository| repository.watched_paths())
            .unwrap_or_default()
    }

    fn repository(
        &self,
        repository_id: Option<&str>,
    ) -> Result<&Arc<GitRepositoryRuntime>, GitRuntimeError> {
        match repository_id {
            Some(id) => self
                .repositories_by_id
                .get(id)
                .ok_or(GitRuntimeError::RepositoryNotFound),
            None => self
                .repositories
                .first()
                .ok_or(GitRuntimeError::RepositoryNotFound),
        }
    }
}

impl GitRepositoryRuntime {
    fn new(
        authorization: Authorization,
        projection_root: PathBuf,
        descriptor: GitRepositoryDto,
        updates: Arc<UpdateBroker>,
    ) -> Result<Option<Self>, GitRuntimeError> {
        let service =
            GitService::new(authorization, projection_root).map_err(GitRuntimeError::Service)?;
        let Ok((repository, _)) = service.snapshot() else {
            return Ok(None);
        };
        Ok(Some(Self {
            operation: ash_git::repository_operation_lock(&repository),
            service,
            descriptor,
            stream_instance_id: new_stream_instance_id()?,
            state: Mutex::new(GitRuntimeState {
                revision: 0,
                repository: None,
                status: None,
            }),
            graph_sessions: Mutex::new(HashMap::new()),
            next_graph_token: AtomicU64::new(1),
            updates,
        }))
    }

    fn status(&self) -> Result<GitStatusResult, GitRuntimeError> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let (repository, snapshot) = self.service.snapshot().map_err(GitRuntimeError::Service)?;
        self.accept(repository, snapshot)
    }

    pub(super) fn local_branches(&self) -> Result<Vec<GitBranchDto>, GitRuntimeError> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        self.local_branches_locked()
    }

    fn local_branches_locked(&self) -> Result<Vec<GitBranchDto>, GitRuntimeError> {
        let occupied = self
            .service
            .checked_out_branches_elsewhere()
            .map_err(GitRuntimeError::Service)?;
        self.service
            .local_branches()
            .map(|branches| {
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
        let _operation = self
            .operation
            .lock()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        self.service
            .create_branch(name)
            .map_err(GitRuntimeError::Service)?;
        self.local_branches_locked()
    }

    pub(super) fn recent_commits(&self) -> Result<Vec<GitCommitSummaryDto>, GitRuntimeError> {
        let _operation = self
            .operation
            .lock()
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

    pub(super) fn graph(
        &self,
        connection_id: u64,
        limit: std::num::NonZeroUsize,
        cursor: Option<&str>,
    ) -> Result<GitGraphResult, GitRuntimeError> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let mut sessions = self
            .graph_sessions
            .lock()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let (graph, next_cursor) = match cursor {
            None => {
                sessions.remove(&connection_id);
                let mut graph_cursor = self
                    .service
                    .open_graph()
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
                    .filter(|session| session.token == cursor)
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
        Ok(project_graph(graph, next_cursor))
    }

    pub(super) fn close_connection(&self, connection_id: u64) {
        if let Ok(mut sessions) = self.graph_sessions.lock() {
            sessions.remove(&connection_id);
        }
    }

    pub(super) fn text_diff(&self) -> Result<GitTextDiffResult, GitRuntimeError> {
        let _operation = self
            .operation
            .lock()
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
        let _operation = self
            .operation
            .lock()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let projected = self
            .service
            .commit_changes(object_id)
            .map_err(GitRuntimeError::Service)?;
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
    ) -> Result<GitCommitFileResult, GitRuntimeError> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let file = self
            .service
            .commit_file(object_id, path)
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
        let _operation = self
            .operation
            .lock()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let file = self
            .service
            .change_file(
                path,
                match comparison {
                    GitChangeFileComparisonDto::Staged => GitChangeFileComparison::Staged,
                    GitChangeFileComparisonDto::Unstaged => GitChangeFileComparison::Unstaged,
                },
            )
            .map_err(GitRuntimeError::Service)?;
        Ok(GitChangeFileResult {
            original: commit_file_content(file.original()),
            modified: commit_file_content(file.modified()),
        })
    }

    pub(super) fn switch_branch(&self, name: &str) -> Result<GitStatusResult, GitRuntimeError> {
        self.mutate_paths(|service| service.switch_branch(name))
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

    pub(super) fn commit(&self, message: String) -> Result<GitRuntimeCommit, GitRuntimeError> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let GitServiceCommit {
            object_id,
            repository,
            snapshot,
        } = self
            .service
            .commit(message)
            .map_err(GitRuntimeError::Service)?;
        self.invalidate_graphs()?;
        Ok(GitRuntimeCommit {
            object_id,
            status: self.accept(repository, snapshot)?,
        })
    }

    pub(super) fn fetch(&self) -> Result<GitStatusResult, GitRuntimeError> {
        self.mutate_remote(GitService::fetch)
    }

    pub(super) fn fetch_default(&self) -> Result<GitStatusResult, GitRuntimeError> {
        self.mutate_remote(GitService::fetch_default)
    }

    pub(super) fn pull_fast_forward(&self) -> Result<GitStatusResult, GitRuntimeError> {
        self.mutate_remote(GitService::pull_fast_forward)
    }

    pub(super) fn push(&self) -> Result<GitStatusResult, GitRuntimeError> {
        self.mutate_remote(GitService::push)
    }

    pub(super) fn start_watching(self: &Arc<Self>) -> GitWatcher {
        let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel();
        let runtime = Arc::downgrade(self);
        let thread = std::thread::Builder::new()
            .name("ash-git-watcher".into())
            .spawn(move || watch_git(runtime, shutdown_rx))
            .ok();
        if thread.is_none() {
            return GitWatcher::default();
        }
        GitWatcher {
            shutdown: Some(shutdown),
            auto_fetch_shutdown: None,
            thread,
            children: Vec::new(),
        }
    }

    fn start_autofetch(self: &Arc<Self>, config: Arc<ConfigStore>) -> GitWatcher {
        let (shutdown, shutdown_rx) = mpsc::channel();
        let runtime = Arc::downgrade(self);
        let thread = std::thread::Builder::new()
            .name("ash-git-autofetch".into())
            .spawn(move || run_autofetch(runtime, config, shutdown_rx))
            .expect("Git automatic-fetch worker starts");
        GitWatcher {
            shutdown: None,
            auto_fetch_shutdown: Some(shutdown),
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
        let _operation = self
            .operation
            .lock()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let (repository, snapshot) = operation(&self.service).map_err(GitRuntimeError::Service)?;
        self.invalidate_graphs()?;
        self.accept(repository, snapshot)
    }

    fn mutate_remote(
        &self,
        operation: fn(
            &GitService,
        ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError>,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let (repository, snapshot) = operation(&self.service).map_err(GitRuntimeError::Service)?;
        self.invalidate_graphs()?;
        self.accept_status(repository, snapshot, StatusNotification::Always)
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
        let mut projected = project_status(
            self.descriptor.id.clone(),
            self.stream_instance_id.clone(),
            self.service.dir_root(),
            &repository,
            snapshot,
        )?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
        let had_state = state.repository.is_some();
        let unchanged = state.repository.as_ref() == Some(&repository)
            && state.status.as_ref().is_some_and(|current| {
                current.head == projected.head && current.changes == projected.changes
            });
        if unchanged && matches!(notification, StatusNotification::OnChange) {
            projected.revision = state.revision;
            return Ok(projected);
        }
        state.revision = state
            .revision
            .checked_add(1)
            .expect("Git status revision overflowed");
        projected.revision = state.revision;
        state.repository = Some(repository);
        state.status = Some(projected.clone());
        drop(state);
        if had_state {
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

    fn refresh_from_watcher(&self) {
        let _ = self.status();
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
        if let Ok(state) = self.state.lock()
            && let Some(repository) = &state.repository
        {
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
        paths.sort_by(|left, right| {
            left.path
                .cmp(&right.path)
                .then(left.recursive.cmp(&right.recursive))
        });
        paths.dedup();
        paths
    }
}

impl Drop for GitWatcher {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(shutdown) = self.auto_fetch_shutdown.take() {
            let _ = shutdown.send(());
        }
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
                GitAutoFetchMode::Default => repository.fetch_default(),
                GitAutoFetchMode::All => repository.fetch(),
                GitAutoFetchMode::Off => unreachable!(),
            };
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

fn watch_git(
    runtime: std::sync::Weak<GitRepositoryRuntime>,
    mut shutdown: tokio::sync::oneshot::Receiver<()>,
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
        let refresh_runtime = Arc::clone(&git_runtime);
        let _ = tokio::task::spawn_blocking(move || refresh_runtime.refresh_from_watcher()).await;
        let mut watched_paths = git_runtime.watched_paths();
        drop(git_runtime);
        let Ok(mut registration) = subscriber.register_paths(watched_paths.clone()) else {
            return;
        };
        let mut receiver = DebouncedWatchReceiver::new(receiver, GIT_WATCH_DEBOUNCE);
        loop {
            tokio::select! {
                _ = &mut shutdown => break,
                event = receiver.recv() => {
                    if event.is_none() {
                        break;
                    }
                    let Some(git_runtime) = runtime.upgrade() else {
                        break;
                    };
                    let refresh_runtime = Arc::clone(&git_runtime);
                    let _ = tokio::task::spawn_blocking(move || {
                        refresh_runtime.refresh_from_watcher();
                    }).await;
                    let next_paths = git_runtime.watched_paths();
                    if next_paths != watched_paths
                        && let Ok(next_registration) =
                            subscriber.register_paths(next_paths.clone())
                    {
                        registration = next_registration;
                        watched_paths = next_paths;
                    }
                }
            }
        }
        drop(registration);
    });
}

fn discover_repository_roots(authorization: &Authorization) -> Vec<PathBuf> {
    const MAX_REPOSITORIES: usize = 128;
    let dir_root = authorization.dir().canonical_path();
    let mut roots = vec![dir_root.to_path_buf()];
    let mut builder = WalkBuilder::new(dir_root);
    builder
        .hidden(false)
        .follow_links(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .parents(false)
        .max_depth(Some(16))
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            entry.depth() == 0
                || !matches!(
                    name.as_ref(),
                    ".git" | "node_modules" | "target" | ".build" | "out" | "dist" | ".cache"
                )
        });
    for entry in builder.build().filter_map(Result::ok) {
        if !entry.file_type().is_some_and(|kind| kind.is_dir())
            || !entry.path().join(".git").exists()
        {
            continue;
        }
        let Ok(parent) = dunce::canonicalize(entry.path()) else {
            continue;
        };
        if parent.starts_with(dir_root) && !roots.iter().any(|root| root == &parent) {
            roots.push(parent);
            if roots.len() >= MAX_REPOSITORIES {
                break;
            }
        }
    }
    roots.sort();
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
        id,
        label,
        path,
        dir_id,
    })
}

fn project_graph(graph: GitGraph, next_cursor: Option<String>) -> GitGraphResult {
    GitGraphResult {
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
        references: graph
            .references()
            .iter()
            .map(|reference| GitReferenceDto {
                name: reference.name().into(),
                object_id: reference.object_id().into(),
                kind: match reference.kind() {
                    GitReferenceKind::LocalBranch => GitReferenceKindDto::LocalBranch,
                    GitReferenceKind::RemoteBranch => GitReferenceKindDto::RemoteBranch,
                },
                remote_name: reference.remote_name().map(Into::into),
                current: reference.is_current(),
            })
            .collect(),
        remotes: graph
            .remotes()
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
            .collect(),
        has_more: graph.has_more(),
        next_cursor,
    }
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

fn head(head: &GitHead) -> GitHeadDto {
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
        Some(content) if content.contains(&0) => GitCommitFileContentDto::Binary,
        Some(content) => match std::str::from_utf8(content) {
            Ok(text) => GitCommitFileContentDto::Text { text: text.into() },
            Err(_) => GitCommitFileContentDto::Binary,
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
