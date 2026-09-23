use ash_file_access::Authorization;
use ash_file_access::Dir;
use ash_file_access::Permission;
use ash_git::GitBranch;
use ash_git::GitChangeFile;
use ash_git::GitChangeFileComparison;
use ash_git::GitChangeStatus;
use ash_git::GitClient;
use ash_git::GitCommitChange;
use ash_git::GitCommitFile;
use ash_git::GitCommitRequest;
use ash_git::GitCommitSummary;
use ash_git::GitError;
use ash_git::GitGraph;
use ash_git::GitGraphCursor;
use ash_git::GitPathspecSet;
use ash_git::GitRepository;
use ash_git::GitRepositorySnapshot;
use ash_git::GitTextDiffLimits;
use ash_git::GitTextDiffSnapshot;
use std::num::NonZeroUsize;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use tokio::runtime::Runtime;

const MAX_TEXT_DIFF_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_COMMIT_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_CHANGE_FILE_BYTES: usize = 2 * 1024 * 1024;
const RECENT_COMMIT_LIMIT: NonZeroUsize = NonZeroUsize::new(50).expect("history limit is non-zero");

pub(crate) struct GitServiceCommit {
    pub(crate) object_id: String,
    pub(crate) repository: GitRepository,
    pub(crate) snapshot: GitRepositorySnapshot,
}

pub(crate) struct GitServiceCommitChanges {
    pub(crate) repository: GitRepository,
    pub(crate) parent_object_id: Option<String>,
    pub(crate) changes: Vec<GitCommitChange>,
}

#[derive(Clone, Copy)]
enum GitPathMutation {
    Stage,
    Unstage,
    DiscardWorktree,
}

#[derive(Clone, Copy)]
enum GitRemoteMutation {
    FetchDefault,
    Fetch,
    PullFastForward,
    Push,
}

/// Directory-scoped owner of the async Git runtime used by synchronous RPC dispatch.
pub(crate) struct GitService {
    authorization: Authorization,
    projection_root: PathBuf,
    client: GitClient,
    runtime: Mutex<Runtime>,
}

impl GitService {
    pub(crate) fn new(
        authorization: Authorization,
        projection_root: PathBuf,
    ) -> Result<Self, GitServiceError> {
        if !matches!(
            authorization.permission(),
            Permission::InspectRepository | Permission::MutateRepository
        ) {
            return Err(GitServiceError::Permission);
        }
        if !projection_root.starts_with(authorization.dir().canonical_path())
            || !projection_root.is_dir()
        {
            return Err(GitServiceError::Boundary);
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| GitServiceError::Runtime)?;
        Ok(Self {
            authorization,
            projection_root,
            client: GitClient::system(),
            runtime: Mutex::new(runtime),
        })
    }

    pub(crate) fn snapshot(
        &self,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.ensure_readable()?;
        let runtime = self.runtime.lock().map_err(|_| GitServiceError::Runtime)?;
        runtime.block_on(async {
            let repository = self
                .client
                .open_repository(&self.projection_root)
                .await
                .map_err(GitServiceError::Git)?;
            let snapshot = self
                .client
                .snapshot(&repository)
                .await
                .map_err(GitServiceError::Git)?;
            Ok((repository, snapshot))
        })
    }

    pub(crate) fn dir_root(&self) -> &Path {
        &self.projection_root
    }

    pub(crate) fn dir(&self) -> &Dir {
        self.authorization.dir()
    }

    pub(crate) fn can_mutate(&self) -> bool {
        self.authorization.permission() == Permission::MutateRepository
    }

    pub(crate) fn stage(
        &self,
        paths: Vec<PathBuf>,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.mutate_paths(GitPathMutation::Stage, paths)
    }

    pub(crate) fn local_branches(&self) -> Result<Vec<GitBranch>, GitServiceError> {
        self.ensure_readable()?;
        let runtime = self.runtime.lock().map_err(|_| GitServiceError::Runtime)?;
        runtime.block_on(async {
            let repository = self.open_repository().await?;
            self.client
                .local_branches(&repository)
                .await
                .map_err(GitServiceError::Git)
        })
    }

    pub(crate) fn recent_commits(&self) -> Result<Vec<GitCommitSummary>, GitServiceError> {
        self.ensure_readable()?;
        let runtime = self.runtime.lock().map_err(|_| GitServiceError::Runtime)?;
        runtime.block_on(async {
            let repository = self.open_repository().await?;
            self.client
                .recent_commits(&repository, RECENT_COMMIT_LIMIT)
                .await
                .map_err(GitServiceError::Git)
        })
    }

    pub(crate) fn open_graph(&self) -> Result<GitGraphCursor, GitServiceError> {
        self.ensure_readable()?;
        let runtime = self.runtime.lock().map_err(|_| GitServiceError::Runtime)?;
        runtime.block_on(async {
            let repository = self.open_repository().await?;
            self.client
                .start_graph(&repository)
                .await
                .map_err(GitServiceError::Git)
        })
    }

    pub(crate) fn graph_page(
        &self,
        cursor: &mut GitGraphCursor,
        limit: NonZeroUsize,
    ) -> Result<GitGraph, GitServiceError> {
        self.ensure_readable()?;
        let runtime = self.runtime.lock().map_err(|_| GitServiceError::Runtime)?;
        runtime
            .block_on(cursor.page(limit))
            .map_err(GitServiceError::Git)
    }

    pub(crate) fn commit_changes(
        &self,
        object_id: &str,
    ) -> Result<GitServiceCommitChanges, GitServiceError> {
        self.ensure_readable()?;
        let runtime = self.runtime.lock().map_err(|_| GitServiceError::Runtime)?;
        runtime.block_on(async {
            let repository = self.open_repository().await?;
            let (parent_object_id, changes) = self
                .client
                .commit_changes(&repository, object_id)
                .await
                .map_err(GitServiceError::Git)?;
            Ok(GitServiceCommitChanges {
                repository,
                parent_object_id,
                changes,
            })
        })
    }

    pub(crate) fn commit_file(
        &self,
        object_id: &str,
        path: &Path,
    ) -> Result<GitCommitFile, GitServiceError> {
        self.ensure_readable()?;
        let runtime = self.runtime.lock().map_err(|_| GitServiceError::Runtime)?;
        runtime.block_on(async {
            let repository = self.open_repository().await?;
            let dir_prefix = self.repository_prefix(&repository)?;
            let repository_path = dir_prefix.join(path);
            let (parent_object_id, changes) = self
                .client
                .commit_changes(&repository, object_id)
                .await
                .map_err(GitServiceError::Git)?;
            let change = changes
                .iter()
                .find(|change| change.path() == repository_path)
                .ok_or(GitServiceError::CommitChangeNotFound)?;
            let original_path = change
                .original_path()
                .filter(|path| path.strip_prefix(&dir_prefix).is_ok());
            self.client
                .commit_file(
                    &repository,
                    object_id,
                    parent_object_id.as_deref(),
                    change.path(),
                    original_path,
                    MAX_COMMIT_FILE_BYTES,
                )
                .await
                .map_err(GitServiceError::Git)
        })
    }

    pub(crate) fn change_file(
        &self,
        path: &Path,
        comparison: GitChangeFileComparison,
    ) -> Result<GitChangeFile, GitServiceError> {
        self.ensure_readable()?;
        let runtime = self.runtime.lock().map_err(|_| GitServiceError::Runtime)?;
        runtime.block_on(async {
            let repository = self.open_repository().await?;
            let dir_prefix = self.repository_prefix(&repository)?;
            let repository_path = dir_prefix.join(path);
            let snapshot = self
                .client
                .snapshot(&repository)
                .await
                .map_err(GitServiceError::Git)?;
            let change = snapshot
                .changes()
                .iter()
                .find(|change| change.path() == repository_path)
                .filter(|change| match comparison {
                    GitChangeFileComparison::Staged => {
                        change.index_status() != GitChangeStatus::Unmodified
                    }
                    GitChangeFileComparison::Unstaged => {
                        change.worktree_status() != GitChangeStatus::Unmodified
                    }
                })
                .ok_or(GitServiceError::CommitChangeNotFound)?;
            let comparison_status = match comparison {
                GitChangeFileComparison::Staged => change.index_status(),
                GitChangeFileComparison::Unstaged => change.worktree_status(),
            };
            if matches!(
                comparison_status,
                GitChangeStatus::Renamed | GitChangeStatus::Copied
            ) && change
                .original_path()
                .is_some_and(|path| path.strip_prefix(&dir_prefix).is_err())
            {
                return Err(GitServiceError::Boundary);
            }
            self.client
                .change_file(&repository, change, comparison, MAX_CHANGE_FILE_BYTES)
                .await
                .map_err(GitServiceError::Git)
        })
    }

    pub(crate) fn text_diff_snapshot(
        &self,
    ) -> Result<(GitRepository, GitTextDiffSnapshot), GitServiceError> {
        self.ensure_readable()?;
        let limits =
            GitTextDiffLimits::new(MAX_TEXT_DIFF_FILE_BYTES).map_err(GitServiceError::Git)?;
        let runtime = self.runtime.lock().map_err(|_| GitServiceError::Runtime)?;
        runtime.block_on(async {
            let repository = self.open_repository().await?;
            let dir_prefix = self.repository_prefix(&repository)?;
            let snapshot = self
                .client
                .text_diff_snapshot_under(&repository, &dir_prefix, limits)
                .await
                .map_err(GitServiceError::Git)?;
            Ok((repository, snapshot))
        })
    }

    pub(crate) fn switch_branch(
        &self,
        name: &str,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.ensure_mutable()?;
        let runtime = self.runtime.lock().map_err(|_| GitServiceError::Runtime)?;
        runtime.block_on(async {
            let repository = self.open_repository().await?;
            let branches = self
                .client
                .local_branches(&repository)
                .await
                .map_err(GitServiceError::Git)?;
            let branch = branches
                .iter()
                .find(|branch| branch.name() == name)
                .ok_or(GitServiceError::BranchNotFound)?;
            self.client
                .switch_branch(&repository, branch)
                .await
                .map_err(GitServiceError::Git)?;
            let snapshot = self
                .client
                .snapshot(&repository)
                .await
                .map_err(GitServiceError::Git)?;
            Ok((repository, snapshot))
        })
    }

    pub(crate) fn unstage(
        &self,
        paths: Vec<PathBuf>,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.mutate_paths(GitPathMutation::Unstage, paths)
    }

    pub(crate) fn discard_worktree(
        &self,
        paths: Vec<PathBuf>,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.mutate_paths(GitPathMutation::DiscardWorktree, paths)
    }

    pub(crate) fn commit(&self, message: String) -> Result<GitServiceCommit, GitServiceError> {
        self.ensure_mutable()?;
        let request = GitCommitRequest::new(message).map_err(GitServiceError::Git)?;
        let runtime = self.runtime.lock().map_err(|_| GitServiceError::Runtime)?;
        runtime.block_on(async {
            let repository = self.open_repository().await?;
            let committed = self
                .client
                .commit(&repository, &request)
                .await
                .map_err(GitServiceError::Git)?;
            let snapshot = self
                .client
                .snapshot(&repository)
                .await
                .map_err(GitServiceError::Git)?;
            Ok(GitServiceCommit {
                object_id: committed.object_id().into(),
                repository,
                snapshot,
            })
        })
    }

    pub(crate) fn fetch(&self) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.mutate_remote(GitRemoteMutation::Fetch)
    }

    pub(crate) fn fetch_default(
        &self,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.mutate_remote(GitRemoteMutation::FetchDefault)
    }

    pub(crate) fn pull_fast_forward(
        &self,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.mutate_remote(GitRemoteMutation::PullFastForward)
    }

    pub(crate) fn push(&self) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.mutate_remote(GitRemoteMutation::Push)
    }

    fn mutate_paths(
        &self,
        operation: GitPathMutation,
        paths: Vec<PathBuf>,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.ensure_mutable()?;
        let runtime = self.runtime.lock().map_err(|_| GitServiceError::Runtime)?;
        runtime.block_on(async {
            let repository = self.open_repository().await?;
            let paths = self.repository_paths(&repository, paths)?;
            match operation {
                GitPathMutation::Stage => self.client.stage(&repository, &paths).await,
                GitPathMutation::Unstage => self.client.unstage(&repository, &paths).await,
                GitPathMutation::DiscardWorktree => {
                    self.client.discard_worktree(&repository, &paths).await
                }
            }
            .map_err(GitServiceError::Git)?;
            let snapshot = self
                .client
                .snapshot(&repository)
                .await
                .map_err(GitServiceError::Git)?;
            Ok((repository, snapshot))
        })
    }

    fn mutate_remote(
        &self,
        operation: GitRemoteMutation,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.ensure_mutable()?;
        let runtime = self.runtime.lock().map_err(|_| GitServiceError::Runtime)?;
        runtime.block_on(async {
            let repository = self.open_repository().await?;
            match operation {
                GitRemoteMutation::FetchDefault => self.client.fetch_default(&repository).await,
                GitRemoteMutation::Fetch => self.client.fetch(&repository).await,
                GitRemoteMutation::PullFastForward => {
                    self.client.pull_fast_forward(&repository).await
                }
                GitRemoteMutation::Push => self.client.push(&repository).await,
            }
            .map_err(GitServiceError::Git)?;
            let snapshot = self
                .client
                .snapshot(&repository)
                .await
                .map_err(GitServiceError::Git)?;
            Ok((repository, snapshot))
        })
    }

    async fn open_repository(&self) -> Result<GitRepository, GitServiceError> {
        self.client
            .open_repository(&self.projection_root)
            .await
            .map_err(GitServiceError::Git)
    }

    fn repository_paths(
        &self,
        repository: &GitRepository,
        paths: Vec<PathBuf>,
    ) -> Result<GitPathspecSet, GitServiceError> {
        let dir_prefix = self.repository_prefix(repository)?;
        GitPathspecSet::new(
            paths
                .into_iter()
                .map(|path| dir_prefix.join(path))
                .collect(),
        )
        .map_err(GitServiceError::Git)
    }

    fn repository_prefix(&self, repository: &GitRepository) -> Result<PathBuf, GitServiceError> {
        self.projection_root
            .strip_prefix(repository.worktree_root())
            .map(Path::to_path_buf)
            .map_err(|_| GitServiceError::Boundary)
    }

    fn ensure_readable(&self) -> Result<(), GitServiceError> {
        if !matches!(
            self.authorization.permission(),
            Permission::InspectRepository | Permission::MutateRepository
        ) {
            return Err(GitServiceError::Permission);
        }
        self.authorization
            .ensure_active()
            .map_err(|_| GitServiceError::Permission)
    }

    fn ensure_mutable(&self) -> Result<(), GitServiceError> {
        if self.authorization.permission() != Permission::MutateRepository {
            return Err(GitServiceError::Permission);
        }
        self.authorization
            .ensure_active()
            .map_err(|_| GitServiceError::Permission)
    }
}

#[derive(Debug)]
pub(crate) enum GitServiceError {
    BranchNotFound,
    Boundary,
    CommitChangeNotFound,
    Git(GitError),
    Runtime,
    Permission,
}
