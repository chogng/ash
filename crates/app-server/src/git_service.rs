use ash_async_utils::CancellationToken;
use ash_async_utils::FutureCancellationExt;
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
use ash_git::GitConflictChoice;
use ash_git::GitError;
use ash_git::GitGraph;
use ash_git::GitGraphCursor;
use ash_git::GitPathspecSet;
use ash_git::GitPullMode;
use ash_git::GitRepository;
use ash_git::GitRepositorySnapshot;
use ash_git::GitTextDiffLimits;
use ash_git::GitTextDiffSnapshot;
use std::cell::RefCell;
use std::collections::HashSet;
use std::num::NonZeroUsize;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use tokio::runtime::Runtime;

thread_local! {
    static INVOCATION: RefCell<Option<CancellationToken>> = const { RefCell::new(None) };
    static CLIENT: RefCell<Option<GitClient>> = const { RefCell::new(None) };
}

pub(crate) fn with_invocation<T>(token: CancellationToken, operation: impl FnOnce() -> T) -> T {
    struct Restore(Option<CancellationToken>);
    impl Drop for Restore {
        fn drop(&mut self) {
            INVOCATION.with(|current| *current.borrow_mut() = self.0.take());
        }
    }
    let previous = INVOCATION.with(|current| current.replace(Some(token)));
    let _restore = Restore(previous);
    operation()
}

pub(crate) fn with_client<T>(client: GitClient, operation: impl FnOnce() -> T) -> T {
    struct Restore(Option<GitClient>);
    impl Drop for Restore {
        fn drop(&mut self) {
            CLIENT.with(|current| *current.borrow_mut() = self.0.take());
        }
    }
    let _restore = Restore(CLIENT.with(|current| current.replace(Some(client))));
    operation()
}

pub(crate) fn current_client() -> GitClient {
    CLIENT
        .with(|current| current.borrow().clone())
        .unwrap_or_else(GitClient::system)
}

pub(crate) fn invocation_cancellation() -> Option<CancellationToken> {
    INVOCATION.with(|current| current.borrow().clone())
}

trait InvocationCancelled {
    fn cancelled() -> Self;
}
impl InvocationCancelled for GitServiceError {
    fn cancelled() -> Self {
        Self::Cancelled
    }
}
impl InvocationCancelled for GitError {
    fn cancelled() -> Self {
        Self::runtime("Git request", "cancelled")
    }
}
impl InvocationCancelled for ash_async_utils::Cancellation {
    fn cancelled() -> Self {
        let source = ash_async_utils::CancellationSource::new();
        source.cancel();
        source.token().cancellation().expect("cancelled source")
    }
}

fn run<T, E: InvocationCancelled>(
    runtime: &Runtime,
    future: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, E> {
    if let Some(token) = invocation_cancellation() {
        runtime.block_on(async {
            tokio::select! {
                biased;
                _ = token.cancelled() => Err(E::cancelled()),
                result = future => result,
            }
        })
    } else {
        runtime.block_on(future)
    }
}

fn lock_current_runtime<T>(
    lock: &Mutex<T>,
) -> Result<std::sync::MutexGuard<'_, T>, GitServiceError> {
    if let Some(token) = invocation_cancellation() {
        lock_for_request(lock, &token)
    } else {
        lock.lock().map_err(|_| GitServiceError::Runtime)
    }
}

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

pub(crate) struct GitRemovalReview {
    pub(crate) head: ash_git::GitHead,
    pub(crate) entries: Vec<GitRemovalEntry>,
}
pub(crate) struct GitRemovalEntry {
    pub(crate) file: ash_file_system::FileRemoval,
    pub(crate) committed: bool,
    pub(crate) changed: bool,
}

pub(crate) struct GitServiceBranches {
    pub(crate) branches: Vec<GitBranch>,
    pub(crate) checked_out_elsewhere: HashSet<String>,
}

pub(crate) enum GitConflictResolution {
    Edited(String),
    Current,
    Incoming,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum GitCommitScope {
    Staged,
    Tracked,
    IncludeUntracked,
}

#[derive(Clone, Copy)]
enum GitPathMutation {
    Stage,
    Unstage,
    DiscardWorktree,
}

#[derive(Clone, Copy)]
pub(crate) enum GitRemoteMutation<'a> {
    FetchDefault,
    Fetch,
    FetchRemote(&'a str),
    Pull(GitPullMode),
    Push,
    PushReviewed(&'a ash_git::GitPushTarget),
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

    fn client(&self) -> GitClient {
        CLIENT
            .with(|current| current.borrow().clone())
            .unwrap_or_else(|| self.client.clone())
    }

    fn canonical_client(&self) -> GitClient {
        self.client()
            .with_similarity_threshold(50)
            .expect("the canonical similarity threshold is valid")
    }

    pub(crate) fn view_snapshot(
        &self,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.snapshot_using(
            self.client(),
            &ash_async_utils::CancellationSource::new().token(),
        )
    }

    pub(crate) fn snapshot(
        &self,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.snapshot_for_request(&ash_async_utils::CancellationSource::new().token())
    }

    pub(crate) fn snapshot_for_request(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.snapshot_using(self.canonical_client(), cancellation)
    }

    fn snapshot_using(
        &self,
        client: GitClient,
        cancellation: &CancellationToken,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_for_request(&self.runtime, cancellation)?;
        run(&runtime, async {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(GitServiceError::Cancelled),
                result = async {
                    let repository = client.open_repository(&self.projection_root).await.map_err(GitServiceError::Git)?;
                    let snapshot = client.snapshot(&repository).await.map_err(GitServiceError::Git)?;
                    Ok((repository, snapshot))
                } => result,
            }
        })
    }

    pub(crate) fn dir_root(&self) -> &Path {
        &self.projection_root
    }

    pub(crate) fn repository_for_request(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<GitRepository, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_for_request(&self.runtime, cancellation)?;
        run(&runtime, async {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(GitServiceError::Cancelled),
                result = self.open_repository() => result,
            }
        })
    }

    pub(crate) fn reference_state_for_request(
        &self,
        repository: &GitRepository,
        cancellation: &CancellationToken,
    ) -> Result<ash_git::GitReferenceState, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_for_request(&self.runtime, cancellation)?;
        let client = self.client();
        run(&runtime, async {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(GitServiceError::Cancelled),
                result = client.reference_state(repository) => result.map_err(GitServiceError::Git),
            }
        })
    }

    pub(crate) fn same_graph_roots_for_request(
        &self,
        repository: &GitRepository,
        previous: &[String],
        current: &[String],
        cancellation: &CancellationToken,
    ) -> Result<bool, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_for_request(&self.runtime, cancellation)?;
        let client = self.client();
        run(&runtime, async {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(GitServiceError::Cancelled),
                result = client.same_graph_roots(repository, previous, current) => result.map_err(GitServiceError::Git),
            }
        })
    }

    pub(crate) fn check_ignore(
        &self,
        paths: &[PathBuf],
        cancellation: &CancellationToken,
    ) -> Result<Vec<PathBuf>, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_for_request(&self.runtime, cancellation)?;
        run(&runtime, async {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(GitServiceError::Cancelled),
                result = async {
                    let repository = self.client().open_repository(&self.projection_root).await?;
                    self.client().check_ignore(&repository, paths).await
                } => result.map_err(GitServiceError::Git),
            }
        })
    }

    pub(crate) fn ignore_watch_paths_for_request(
        &self,
        repository: &GitRepository,
        cancellation: &CancellationToken,
    ) -> Result<Vec<PathBuf>, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_for_request(&self.runtime, cancellation)?;
        let client = self.client();
        run(&runtime, async {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(GitServiceError::Cancelled),
                result = client.ignore_watch_paths(repository) => result.map_err(GitServiceError::Git),
            }
        })
    }

    pub(crate) fn dir(&self) -> &Dir {
        self.authorization.dir()
    }

    pub(crate) fn can_mutate(&self) -> bool {
        self.authorization.permission() == Permission::MutateRepository
    }

    pub(crate) fn mutable_source(&self) -> Result<PathBuf, GitServiceError> {
        self.ensure_mutable()?;
        Ok(self.projection_root.clone())
    }

    pub(crate) fn readable_source(&self) -> Result<PathBuf, GitServiceError> {
        self.ensure_readable()?;
        Ok(self.projection_root.clone())
    }

    pub(crate) fn stage(
        &self,
        paths: Vec<PathBuf>,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.mutate_paths(GitPathMutation::Stage, paths)
    }

    pub(crate) fn blame(
        &self,
        path: &Path,
        line: usize,
        ignore_whitespace: bool,
        contents: Option<&str>,
    ) -> Result<ash_git::GitBlameLine, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_current_runtime(&self.runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            let path = self.repository_prefix(&repository)?.join(path);
            self.client()
                .blame_line(&repository, &path, line, ignore_whitespace, contents)
                .await
                .map_err(GitServiceError::Git)
        })
    }

    pub(crate) fn file_history(
        &self,
        path: &Path,
    ) -> Result<Vec<ash_git::GitFileHistoryItem>, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_current_runtime(&self.runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            let path = self.repository_prefix(&repository)?.join(path);
            {
                let mut items = self
                    .client()
                    .file_history(&repository, &path)
                    .await
                    .map_err(GitServiceError::Git)?;
                let prefix = self.repository_prefix(&repository)?;
                for item in &mut items {
                    item.path = item
                        .path
                        .strip_prefix(&prefix)
                        .map_err(|_| GitServiceError::Boundary)?
                        .to_path_buf();
                }
                Ok(items)
            }
        })
    }

    pub(crate) fn local_branches(&self) -> Result<GitServiceBranches, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            let worktrees = self
                .client()
                .worktrees(&repository)
                .await
                .map_err(GitServiceError::Git)?;
            let checked_out_elsewhere = worktrees
                .into_iter()
                .filter(|worktree| worktree.checkout_root() != repository.worktree_root())
                .filter_map(|worktree| worktree.branch().map(str::to_owned))
                .collect();
            let branches = self
                .client()
                .local_branches(&repository)
                .await
                .map_err(GitServiceError::Git)?;
            Ok(GitServiceBranches {
                branches,
                checked_out_elsewhere,
            })
        })
    }

    pub(crate) fn pull_upstream_was_rewritten(&self) -> Result<bool, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_current_runtime(&self.runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            self.client()
                .pull_upstream_was_rewritten(&repository)
                .await
                .map_err(GitServiceError::Git)
        })
    }

    pub(crate) fn catalog(&self) -> Result<ash_git::GitCatalog, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            self.client()
                .catalog(&repository)
                .await
                .map_err(GitServiceError::Git)
        })
    }

    pub(crate) fn command(
        &self,
        command: &ash_git::GitCommand,
        cancellation: &CancellationToken,
    ) -> Result<ash_git::GitCommandOutcome, GitServiceError> {
        self.ensure_mutable()?;
        let runtime = lock_for_request(&self.runtime, cancellation)?;
        run(
            &runtime,
            async {
                let repository = self.open_repository().await?;
                // These intents affect checkout-wide state and cannot run through a grant for only
                // a nested directory. Path-limited stage/unstage remain available to nested grants.
                if !repository
                    .worktree_root()
                    .starts_with(self.authorization.dir().canonical_path())
                {
                    return Err(GitServiceError::Boundary);
                }
                self.client()
                    .execute_command(&repository, command)
                    .await
                    .map_err(GitServiceError::Git)
            }
            .with_cancellation(cancellation.clone()),
        )
        .map_err(|_| GitServiceError::Cancelled)?
    }

    pub(crate) fn index_diff(
        &self,
        path: &Path,
        comparison: GitChangeFileComparison,
    ) -> Result<ash_git::GitIndexDiff, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            let path = self.repository_prefix(&repository)?.join(path);
            self.client()
                .index_diff(&repository, &path, comparison)
                .await
                .map_err(GitServiceError::Git)
        })
    }

    pub(crate) fn index_edit(
        &self,
        request: &ash_git::GitIndexEdit,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.ensure_mutable()?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            let scoped = ash_git::GitIndexEdit {
                path: self.repository_prefix(&repository)?.join(&request.path),
                comparison: request.comparison,
                expected_original: request.expected_original.clone(),
                expected_modified: request.expected_modified.clone(),
                selection: request.selection.clone(),
            };
            self.client()
                .edit_index(&repository, &scoped)
                .await
                .map_err(GitServiceError::Git)?;
            let snapshot = self
                .canonical_client()
                .snapshot(&repository)
                .await
                .map_err(GitServiceError::Git)?;
            Ok((repository, snapshot))
        })
    }

    pub(crate) fn create_branch(&self, name: &str) -> Result<(), GitServiceError> {
        self.ensure_mutable()?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            self.client()
                .create_branch(&repository, name)
                .await
                .map_err(GitServiceError::Git)
        })
    }

    pub(crate) fn delete_branch(&self, name: &str) -> Result<(), GitServiceError> {
        self.ensure_mutable()?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            self.client()
                .delete_merged_branch(&repository, name)
                .await
                .map_err(GitServiceError::Git)
        })
    }

    pub(crate) fn recent_commits(&self) -> Result<Vec<GitCommitSummary>, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            self.client()
                .recent_commits(&repository, RECENT_COMMIT_LIMIT)
                .await
                .map_err(GitServiceError::Git)
        })
    }

    pub(crate) fn open_graph(
        &self,
        revisions: Option<&[String]>,
    ) -> Result<GitGraphCursor, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            self.client()
                .start_graph_for_refs(&repository, revisions)
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
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, cursor.page(limit)).map_err(GitServiceError::Git)
    }

    pub(crate) fn commit_changes(
        &self,
        object_id: &str,
    ) -> Result<GitServiceCommitChanges, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            let (parent_object_id, changes) = self
                .client()
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

    pub(crate) fn compare_changes(
        &self,
        object_id: &str,
        base_reference: &str,
        mode: ash_git::GitComparisonMode,
    ) -> Result<GitServiceCommitChanges, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            let (base, changes) = self
                .client()
                .compare_changes(&repository, object_id, base_reference, mode)
                .await
                .map_err(GitServiceError::Git)?;
            Ok(GitServiceCommitChanges {
                repository,
                parent_object_id: Some(base),
                changes,
            })
        })
    }

    pub(crate) fn commit_message(&self, object_id: &str) -> Result<String, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            self.client()
                .commit_message(&repository, object_id)
                .await
                .map_err(GitServiceError::Git)
        })
    }

    pub(crate) fn commit_details(
        &self,
        object_id: &str,
    ) -> Result<ash_git::GitCommitDetails, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            self.client()
                .commit_details(&repository, object_id)
                .await
                .map_err(GitServiceError::Git)
        })
    }

    pub(crate) fn commit_file(
        &self,
        object_id: &str,
        path: &Path,
        comparison_base: Option<&str>,
    ) -> Result<GitCommitFile, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            let dir_prefix = self.repository_prefix(&repository)?;
            let repository_path = dir_prefix.join(path);
            let (parent_object_id, changes) = match comparison_base {
                Some(base) => {
                    let (base, changes) = self
                        .client()
                        .compare_changes(
                            &repository,
                            object_id,
                            base,
                            ash_git::GitComparisonMode::Direct,
                        )
                        .await
                        .map_err(GitServiceError::Git)?;
                    (Some(base), changes)
                }
                None => self
                    .client()
                    .commit_changes(&repository, object_id)
                    .await
                    .map_err(GitServiceError::Git)?,
            };
            let change = changes
                .iter()
                .find(|change| change.path() == repository_path)
                .ok_or(GitServiceError::CommitChangeNotFound)?;
            let original_path = change
                .original_path()
                .filter(|path| path.strip_prefix(&dir_prefix).is_ok());
            self.client()
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
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            let dir_prefix = self.repository_prefix(&repository)?;
            let repository_path = dir_prefix.join(path);
            let snapshot = self
                .canonical_client()
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
            self.client()
                .change_file(&repository, change, comparison, MAX_CHANGE_FILE_BYTES)
                .await
                .map_err(GitServiceError::Git)
        })
    }

    pub(crate) fn change_file_at_paths(
        &self,
        original_path: &Path,
        modified_path: &Path,
        comparison: GitChangeFileComparison,
    ) -> Result<GitChangeFile, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            let dir_prefix = self.repository_prefix(&repository)?;
            self.client()
                .change_file_at_paths(
                    &repository,
                    &dir_prefix.join(original_path),
                    &dir_prefix.join(modified_path),
                    comparison,
                    MAX_CHANGE_FILE_BYTES,
                )
                .await
                .map_err(GitServiceError::Git)
        })
    }

    pub(crate) fn conflict_file(
        &self,
        path: &Path,
    ) -> Result<ash_git::GitConflictFile, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            let repository_path = self.repository_prefix(&repository)?.join(path);
            let snapshot = self
                .canonical_client()
                .snapshot(&repository)
                .await
                .map_err(GitServiceError::Git)?;
            let change = snapshot
                .changes()
                .iter()
                .find(|change| change.path() == repository_path && change.is_conflicted())
                .ok_or(GitServiceError::ConflictChanged)?;
            self.client()
                .conflict_file(&repository, change, MAX_CHANGE_FILE_BYTES)
                .await
                .map_err(GitServiceError::Git)
        })
    }

    pub(crate) fn complete_conflict(
        &self,
        path: &Path,
        expected_stage_ids: [Option<String>; 3],
        expected_result_object_id: Option<String>,
        resolution: GitConflictResolution,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.ensure_mutable()?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            let paths = self.repository_paths(&repository, vec![path.to_path_buf()])?;
            let repository_path = &paths.paths()[0];
            let snapshot = self
                .canonical_client()
                .snapshot(&repository)
                .await
                .map_err(GitServiceError::Git)?;
            let change = snapshot
                .changes()
                .iter()
                .find(|change| change.path() == repository_path && change.is_conflicted())
                .ok_or(GitServiceError::ConflictChanged)?;
            let file = self
                .client()
                .conflict_file(&repository, change, MAX_CHANGE_FILE_BYTES)
                .await
                .map_err(GitServiceError::Git)?;
            if file.stage_ids() != &expected_stage_ids {
                return Err(GitServiceError::ConflictChanged);
            }
            if file.result_object_id() != expected_result_object_id.as_deref() {
                return Err(GitServiceError::ConflictChanged);
            }
            match resolution {
                GitConflictResolution::Edited(text) => {
                    if file.result() != Some(text.as_bytes()) || has_conflict_markers(&text) {
                        return Err(GitServiceError::ConflictChanged);
                    }
                    self.client()
                        .complete_conflict(&repository, repository_path)
                        .await
                        .map_err(GitServiceError::Git)?;
                }
                GitConflictResolution::Current => {
                    let choice = if expected_stage_ids[1].is_some() {
                        GitConflictChoice::Current
                    } else {
                        GitConflictChoice::Delete
                    };
                    self.client()
                        .choose_conflict_side(&repository, repository_path, choice)
                        .await
                        .map_err(GitServiceError::Git)?;
                }
                GitConflictResolution::Incoming => {
                    let choice = if expected_stage_ids[2].is_some() {
                        GitConflictChoice::Incoming
                    } else {
                        GitConflictChoice::Delete
                    };
                    self.client()
                        .choose_conflict_side(&repository, repository_path, choice)
                        .await
                        .map_err(GitServiceError::Git)?;
                }
            }
            let snapshot = self
                .canonical_client()
                .snapshot(&repository)
                .await
                .map_err(GitServiceError::Git)?;
            Ok((repository, snapshot))
        })
    }

    pub(crate) fn text_diff_snapshot(
        &self,
    ) -> Result<(GitRepository, GitTextDiffSnapshot), GitServiceError> {
        self.ensure_readable()?;
        let limits =
            GitTextDiffLimits::new(MAX_TEXT_DIFF_FILE_BYTES).map_err(GitServiceError::Git)?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            let dir_prefix = self.repository_prefix(&repository)?;
            let snapshot = self
                .client()
                .text_diff_snapshot_under(&repository, &dir_prefix, limits)
                .await
                .map_err(GitServiceError::Git)?;
            Ok((repository, snapshot))
        })
    }

    pub(crate) fn switch_branch(
        &self,
        name: &str,
        policy: ash_git::GitCheckoutPolicy,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.ensure_mutable()?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            let branches = self
                .client()
                .local_branches(&repository)
                .await
                .map_err(GitServiceError::Git)?;
            let branch = branches
                .iter()
                .find(|branch| branch.name() == name)
                .ok_or(GitServiceError::BranchNotFound)?;
            self.client()
                .switch_branch_with_policy(&repository, branch, policy)
                .await
                .map_err(GitServiceError::Git)?;
            let snapshot = self
                .canonical_client()
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

    pub(crate) fn has_ai_contribution(
        &self,
        records: &[git_turn_changes::TurnChangeSet],
        scope: GitCommitScope,
        editor_evidence: &[(PathBuf, String)],
    ) -> Result<bool, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            let status = self
                .canonical_client()
                .snapshot(&repository)
                .await
                .map_err(GitServiceError::Git)?;
            let prefix = self.repository_prefix(&repository)?;
            for change in status.changes() {
                if !change.path().starts_with(&prefix) {
                    continue;
                }
                if scope == GitCommitScope::Staged
                    && change.index_status() == ash_git::GitChangeStatus::Unmodified
                    || scope == GitCommitScope::Tracked
                        && change.worktree_status() == ash_git::GitChangeStatus::Untracked
                {
                    continue;
                }
                let comparison = if scope == GitCommitScope::Staged {
                    GitChangeFileComparison::Staged
                } else {
                    GitChangeFileComparison::Unstaged
                };
                let candidate = self
                    .client()
                    .change_file(&repository, change, comparison, MAX_CHANGE_FILE_BYTES)
                    .await
                    .map_err(GitServiceError::Git)?;
                let head = self
                    .client()
                    .read_file_at_revision(
                        &repository,
                        change.path(),
                        ash_git::GitFileRevision::Head,
                        MAX_CHANGE_FILE_BYTES,
                    )
                    .await
                    .map_err(GitServiceError::Git)?;
                if candidate.modified() == head.as_deref() {
                    continue;
                }
                if editor_evidence.iter().any(|(path, text)| {
                    prefix.join(path) == change.path()
                        && candidate.modified() == Some(text.as_bytes())
                }) {
                    return Ok(true);
                }
                for record in records.iter().filter(|record| {
                    record.worktree_root == repository.worktree_root()
                        && record.capture_state == git_turn_changes::CaptureState::Sealed
                        && !record.attribution_incomplete
                }) {
                    for file in record
                        .files
                        .iter()
                        .filter(|file| file.path == change.path())
                    {
                        let after = match file.after_object_id.as_deref() {
                            Some(id) => Some(
                                self.client()
                                    .read_blob(&repository, id, MAX_CHANGE_FILE_BYTES)
                                    .await
                                    .map_err(GitServiceError::Git)?
                                    .0,
                            ),
                            None => None,
                        };
                        if candidate.modified() == after.as_deref() {
                            return Ok(true);
                        }
                    }
                }
            }
            Ok(false)
        })
    }
    pub(crate) fn review_removal(
        &self,
        paths: Vec<PathBuf>,
    ) -> Result<GitRemovalReview, GitServiceError> {
        self.ensure_readable()?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            let normalized = self.repository_paths(&repository, paths.clone())?;
            if normalized.paths().iter().any(|path| {
                path.components().any(|part| {
                    part.as_os_str()
                        .to_str()
                        .is_some_and(|value| value.eq_ignore_ascii_case(".git"))
                })
            }) {
                return Err(GitServiceError::Boundary);
            }
            let snapshot = self
                .canonical_client()
                .snapshot(&repository)
                .await
                .map_err(GitServiceError::Git)?;
            let committed = if matches!(snapshot.head(), ash_git::GitHead::Unborn { .. }) {
                Vec::new()
            } else {
                self.client()
                    .committed_paths(&repository, &normalized)
                    .await
                    .map_err(GitServiceError::Git)?
            };
            let prefix = self
                .projection_root
                .strip_prefix(self.dir().canonical_path())
                .map_err(|_| GitServiceError::Boundary)?;
            let files = ash_file_system::review_file_removals(
                self.dir(),
                &paths
                    .iter()
                    .map(|path| prefix.join(path))
                    .collect::<Vec<_>>(),
            )
            .map_err(removal_error)?;
            Ok(GitRemovalReview {
                head: snapshot.head().clone(),
                entries: files
                    .into_iter()
                    .zip(paths)
                    .zip(normalized.paths())
                    .map(|((mut file, path), full)| {
                        file.path = path;
                        GitRemovalEntry {
                            file,
                            committed: committed.contains(full),
                            changed: snapshot
                                .changes()
                                .iter()
                                .any(|change| change.path() == full),
                        }
                    })
                    .collect(),
            })
        })
    }
    pub(crate) fn remove_files(
        &self,
        entries: Vec<ash_file_system::FileRemoval>,
        mode: ash_file_system::FileRemovalMode,
        expected_head: &ash_git::GitHead,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.ensure_mutable()?;
        let review =
            self.review_removal(entries.iter().map(|entry| entry.path.clone()).collect())?;
        let same_head = match (&review.head, expected_head) {
            (
                ash_git::GitHead::Branch {
                    name: a,
                    object_id: b,
                    ..
                },
                ash_git::GitHead::Branch {
                    name: c,
                    object_id: d,
                    ..
                },
            ) => a == c && b == d,
            (
                ash_git::GitHead::Detached { object_id: a },
                ash_git::GitHead::Detached { object_id: b },
            ) => a == b,
            (ash_git::GitHead::Unborn { name: a }, ash_git::GitHead::Unborn { name: b }) => a == b,
            _ => false,
        };
        if !same_head
            || !review
                .entries
                .iter()
                .map(|entry| &entry.file)
                .eq(entries.iter())
        {
            return Err(GitServiceError::ConflictChanged);
        }
        let prefix = self
            .projection_root
            .strip_prefix(self.dir().canonical_path())
            .map_err(|_| GitServiceError::Boundary)?;
        let entries = entries
            .into_iter()
            .map(|mut entry| {
                entry.path = prefix.join(entry.path);
                entry
            })
            .collect::<Vec<_>>();
        self.ensure_mutable()?;
        ash_file_system::remove_reviewed_files(self.dir(), &entries, mode)
            .map_err(removal_error)?;
        self.snapshot()
    }

    pub(crate) fn commit(
        &self,
        request: GitCommitRequest,
    ) -> Result<GitServiceCommit, GitServiceError> {
        self.ensure_mutable()?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            // Even an index-only commit publishes checkout-wide state, including staged paths
            // outside a nested grant. Validate the whole checkout before any staging or commit.
            if !repository
                .worktree_root()
                .starts_with(self.authorization.dir().canonical_path())
            {
                return Err(GitServiceError::Boundary);
            }
            let committed = self
                .client()
                .commit(&repository, &request)
                .await
                .map_err(GitServiceError::Git)?;
            let snapshot = self
                .canonical_client()
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

    pub(crate) fn fetch(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.mutate_remote(GitRemoteMutation::Fetch, cancellation)
    }

    pub(crate) fn fetch_default(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.mutate_remote(GitRemoteMutation::FetchDefault, cancellation)
    }

    pub(crate) fn fetch_remote(
        &self,
        name: &str,
        cancellation: &CancellationToken,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.mutate_remote(GitRemoteMutation::FetchRemote(name), cancellation)
    }

    pub(crate) fn pull(
        &self,
        mode: GitPullMode,
        cancellation: &CancellationToken,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.mutate_remote(GitRemoteMutation::Pull(mode), cancellation)
    }

    pub(crate) fn push(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.mutate_remote(GitRemoteMutation::Push, cancellation)
    }

    fn mutate_paths(
        &self,
        operation: GitPathMutation,
        paths: Vec<PathBuf>,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.ensure_mutable()?;
        let runtime = lock_current_runtime(&self.runtime).map_err(|_| GitServiceError::Runtime)?;
        run(&runtime, async {
            let repository = self.open_repository().await?;
            let paths = self.repository_paths(&repository, paths)?;
            match operation {
                GitPathMutation::Stage => self.client().stage(&repository, &paths).await,
                GitPathMutation::Unstage => self.client().unstage(&repository, &paths).await,
                GitPathMutation::DiscardWorktree => {
                    self.client().discard_worktree(&repository, &paths).await
                }
            }
            .map_err(GitServiceError::Git)?;
            let snapshot = self
                .canonical_client()
                .snapshot(&repository)
                .await
                .map_err(GitServiceError::Git)?;
            Ok((repository, snapshot))
        })
    }

    fn mutate_remote(
        &self,
        operation: GitRemoteMutation<'_>,
        cancellation: &CancellationToken,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.remote_with_options(
            operation,
            ash_git::GitTransportOptions::default(),
            cancellation,
        )
    }

    pub(crate) fn remote_with_options(
        &self,
        operation: GitRemoteMutation<'_>,
        options: ash_git::GitTransportOptions,
        cancellation: &CancellationToken,
    ) -> Result<(GitRepository, GitRepositorySnapshot), GitServiceError> {
        self.ensure_mutable()?;
        let runtime = lock_for_request(&self.runtime, cancellation)?;
        run(
            &runtime,
            async {
                let repository = self.open_repository().await?;
                match operation {
                    GitRemoteMutation::FetchDefault => {
                        self.client()
                            .fetch_with_options(&repository, None, false, options)
                            .await
                    }
                    GitRemoteMutation::Fetch => {
                        self.client()
                            .fetch_with_options(&repository, None, true, options)
                            .await
                    }
                    GitRemoteMutation::FetchRemote(name) => {
                        self.client()
                            .fetch_with_options(&repository, Some(name), false, options)
                            .await
                    }
                    GitRemoteMutation::Pull(mode) => {
                        self.client()
                            .pull_with_options(&repository, mode, options)
                            .await
                    }
                    GitRemoteMutation::Push => {
                        self.client().push_with_options(&repository, options).await
                    }
                    GitRemoteMutation::PushReviewed(target) => {
                        self.client()
                            .push_reviewed(&repository, target, options)
                            .await
                    }
                }
                .map_err(GitServiceError::Git)?;
                let snapshot = self
                    .canonical_client()
                    .snapshot(&repository)
                    .await
                    .map_err(GitServiceError::Git)?;
                Ok((repository, snapshot))
            }
            .with_cancellation(cancellation.clone()),
        )
        .map_err(|_| GitServiceError::Cancelled)?
    }

    async fn open_repository(&self) -> Result<GitRepository, GitServiceError> {
        self.client()
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
    Cancelled,
    BranchNotFound,
    Boundary,
    CommitChangeNotFound,
    ConflictChanged,
    Git(GitError),
    Runtime,
    Permission,
}

fn has_conflict_markers(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim_end_matches('\r');
        line.starts_with("<<<<<<< ")
            || line == "<<<<<<<"
            || line.starts_with("||||||| ")
            || line == "|||||||"
            || line == "======="
            || line.starts_with(">>>>>>> ")
            || line == ">>>>>>>"
    })
}

/// Repository background work shares these locks with RPC. A disconnected caller must leave
/// the wait as well as the Git future; the short polling interval bounds synchronous lock waits.
pub(crate) fn lock_for_request<'a, T>(
    lock: &'a Mutex<T>,
    cancellation: &CancellationToken,
) -> Result<std::sync::MutexGuard<'a, T>, GitServiceError> {
    loop {
        cancellation
            .check()
            .map_err(|_| GitServiceError::Cancelled)?;
        match lock.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(std::sync::TryLockError::Poisoned(_)) => return Err(GitServiceError::Runtime),
            Err(std::sync::TryLockError::WouldBlock) => {
                std::thread::sleep(std::time::Duration::from_millis(10))
            }
        }
    }
}

#[cfg(all(test, unix))]
#[path = "git_service_tests.rs"]
mod tests;

fn removal_error(error: std::io::Error) -> GitServiceError {
    GitServiceError::Git(GitError::io("remove reviewed files", error))
}
