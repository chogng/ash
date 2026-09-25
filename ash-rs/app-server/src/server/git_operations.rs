use super::AppServer;
use super::RpcError;
use super::decode;
use super::result;
use crate::git_service::GitServiceError;
use crate::server::git_runtime::GitRuntimeError;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::git::GitBranchCreateParams;
use ash_app_server_protocol::protocol::git::GitBranchListResult;
use ash_app_server_protocol::protocol::git::GitBranchSwitchParams;
use ash_app_server_protocol::protocol::git::GitChangeFileParams;
use ash_app_server_protocol::protocol::git::GitCommitChangesParams;
use ash_app_server_protocol::protocol::git::GitCommitFileParams;
use ash_app_server_protocol::protocol::git::GitCommitParams;
use ash_app_server_protocol::protocol::git::GitCommitResult as GitCommitResultDto;
use ash_app_server_protocol::protocol::git::GitFetchModeDto;
use ash_app_server_protocol::protocol::git::GitFetchParams;
use ash_app_server_protocol::protocol::git::GitGraphParams;
use ash_app_server_protocol::protocol::git::GitHistoryResult;
use ash_app_server_protocol::protocol::git::GitOperationResult;
use ash_app_server_protocol::protocol::git::GitPathsParams;
use ash_app_server_protocol::protocol::git::GitRepositoryParams;
use ash_app_server_protocol::protocol::git::GitWorktreeCreateParams;
use ash_app_server_protocol::protocol::git::GitWorktreeCreateResult;
use ash_app_server_protocol::protocol::git::GitWorktreeDto;
use ash_app_server_protocol::protocol::git::GitWorktreeListResult;
use ash_app_server_protocol::protocol::git::GitWorktreeResolveParams;
use ash_app_server_protocol::protocol::git::GitWorktreeResolveResult;
use ash_app_server_protocol::protocol::git::GitWorktreeStateDto;
use ash_git::GitError;
use serde_json::Value;
use std::num::NonZeroUsize;
use std::path::Path;
use std::path::PathBuf;
use worktree::WorktreeAvailability;
use worktree::WorktreeOwner;
use worktree::WorktreeSelector;

const MAX_GIT_GRAPH_PAGE_SIZE: usize = 1000;

impl AppServer {
    pub(super) fn git_repositories(&self) -> Result<Value, RpcError> {
        result(&self.git_runtime_service()?.repositories())
    }

    pub(super) fn git_status(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitRepositoryParams = decode(value)?;
        result(
            &self
                .git_runtime_service()?
                .status_for(params.repository_id.as_deref())
                .map_err(git_error)?,
        )
    }

    pub(super) fn git_text_diff(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitRepositoryParams = decode(value)?;
        result(
            &self
                .git_runtime_service()?
                .text_diff_for(params.repository_id.as_deref())
                .map_err(git_error)?,
        )
    }

    pub(super) fn git_branch_list(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitRepositoryParams = decode(value)?;
        let branches = self
            .git_runtime_service()?
            .local_branches_for(params.repository_id.as_deref())
            .map_err(git_error)?;
        result(&GitBranchListResult { branches })
    }

    pub(super) fn git_history(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitRepositoryParams = decode(value)?;
        let commits = self
            .git_runtime_service()?
            .recent_commits_for(params.repository_id.as_deref())
            .map_err(git_error)?;
        result(&GitHistoryResult { commits })
    }

    pub(super) fn git_graph(&self, connection_id: u64, value: &Value) -> Result<Value, RpcError> {
        let params: GitGraphParams = decode(value)?;
        if params.limit == 0 || params.limit > MAX_GIT_GRAPH_PAGE_SIZE {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let limit = NonZeroUsize::new(params.limit).expect("validated graph page size");
        result(
            &self
                .git_runtime_service()?
                .graph_for(
                    params.repository_id.as_deref(),
                    connection_id,
                    limit,
                    params.cursor.as_deref(),
                )
                .map_err(git_error)?,
        )
    }

    pub(super) fn git_commit_changes(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitCommitChangesParams = decode(value)?;
        validate_object_id(&params.object_id)?;
        result(
            &self
                .git_runtime_service()?
                .commit_changes_for(params.repository_id.as_deref(), &params.object_id)
                .map_err(git_error)?,
        )
    }

    pub(super) fn git_commit_file(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitCommitFileParams = decode(value)?;
        validate_object_id(&params.object_id)?;
        let path = paths(vec![params.path])?
            .pop()
            .expect("validated commit file path");
        result(
            &self
                .git_runtime_service()?
                .commit_file_for(params.repository_id.as_deref(), &params.object_id, &path)
                .map_err(git_error)?,
        )
    }

    pub(super) fn git_change_file(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitChangeFileParams = decode(value)?;
        let path = paths(vec![params.path])?
            .pop()
            .expect("validated change file path");
        result(
            &self
                .git_runtime_service()?
                .change_file_for(params.repository_id.as_deref(), &path, params.comparison)
                .map_err(git_error)?,
        )
    }

    pub(super) fn git_branch_switch(&self, params: &Value) -> Result<Value, RpcError> {
        let params: GitBranchSwitchParams = decode(params)?;
        if params.name.trim().is_empty() || params.name.len() > 1024 || params.name.contains('\0') {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let status = self
            .git_runtime_service()?
            .switch_branch_for(params.repository_id.as_deref(), &params.name)
            .map_err(git_error)?;
        result(&GitOperationResult { status })
    }

    pub(super) fn git_branch_create(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitBranchCreateParams = decode(value)?;
        if params.name.trim().is_empty() || params.name.len() > 1024 || params.name.contains('\0') {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let branches = self
            .git_runtime_service()?
            .create_branch_for(params.repository_id.as_deref(), &params.name)
            .map_err(git_error)?;
        result(&GitBranchListResult { branches })
    }

    pub(super) fn git_worktree_create(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitWorktreeCreateParams = decode(value)?;
        let source = self
            .git_runtime_service()?
            .mutable_source_for(params.repository_id.as_deref())
            .map_err(git_error)?;
        let dirs = &self
            .dir_services
            .as_ref()
            .ok_or_else(|| RpcError::new(-32060, AppServerErrorName::GitUnavailable))?;
        let path = dirs
            .runtime
            .block_on(dirs.worktrees.create_unbound(&source, &params.name))
            .map_err(|_| RpcError::new(-32061, AppServerErrorName::GitOperationFailed))?;
        // List results use canonical paths; match that spelling so the new checkout is selected.
        let path = dunce::canonicalize(path)
            .map_err(|_| RpcError::new(-32061, AppServerErrorName::GitOperationFailed))?;
        result(&GitWorktreeCreateResult {
            path: worktree_path(&path)?,
        })
    }

    pub(super) fn git_worktree_list(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitRepositoryParams = decode(value)?;
        let source = self
            .git_runtime_service()?
            .readable_source_for(params.repository_id.as_deref())
            .map_err(git_error)?;
        let dirs = self
            .dir_services
            .as_ref()
            .ok_or_else(|| RpcError::new(-32060, AppServerErrorName::GitUnavailable))?;
        let worktrees = dirs
            .runtime
            .block_on(dirs.worktrees.list(&source))
            .map_err(|_| RpcError::new(-32061, AppServerErrorName::GitOperationFailed))?
            .into_iter()
            .map(|worktree| {
                let state = match worktree.availability() {
                    WorktreeAvailability::Prunable { .. } => GitWorktreeStateDto::Prunable,
                    WorktreeAvailability::Locked { .. } => GitWorktreeStateDto::Locked,
                    WorktreeAvailability::Ready => match worktree.owner() {
                        WorktreeOwner::Thread(_) => GitWorktreeStateDto::ThreadOwned,
                        WorktreeOwner::Invalid => GitWorktreeStateDto::Invalid,
                        WorktreeOwner::Unbound if !worktree.dir().is_dir() => {
                            GitWorktreeStateDto::MissingDirectory
                        }
                        WorktreeOwner::Unbound => GitWorktreeStateDto::Ready,
                    },
                };
                let (checkout_root, path) = if state == GitWorktreeStateDto::Ready {
                    let checkout_root =
                        dunce::canonicalize(worktree.checkout_root()).map_err(|_| {
                            RpcError::new(-32061, AppServerErrorName::GitOperationFailed)
                        })?;
                    let path = dunce::canonicalize(worktree.dir()).map_err(|_| {
                        RpcError::new(-32061, AppServerErrorName::GitOperationFailed)
                    })?;
                    (checkout_root, path)
                } else {
                    (
                        worktree.checkout_root().to_path_buf(),
                        worktree.dir().to_path_buf(),
                    )
                };
                Ok(GitWorktreeDto {
                    checkout_root: worktree_path(&checkout_root)?,
                    path: worktree_path(&path)?,
                    branch: worktree.branch().map(str::to_owned),
                    head: worktree.head().to_owned(),
                    current: worktree.is_current(),
                    state,
                })
            })
            .collect::<Result<Vec<_>, RpcError>>()?;
        result(&GitWorktreeListResult { worktrees })
    }

    pub(super) fn git_worktree_resolve(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitWorktreeResolveParams = decode(value)?;
        if params.checkout_root.is_empty() || params.checkout_root.len() > 32_768 {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let source = self
            .git_runtime_service()?
            .readable_source_for(params.repository_id.as_deref())
            .map_err(git_error)?;
        let dirs = self
            .dir_services
            .as_ref()
            .ok_or_else(|| RpcError::new(-32060, AppServerErrorName::GitUnavailable))?;
        let worktree = dirs
            .runtime
            .block_on(dirs.worktrees.resolve(
                &source,
                &WorktreeSelector::CheckoutRoot(PathBuf::from(params.checkout_root)),
            ))
            .map_err(|_| RpcError::new(-32061, AppServerErrorName::GitOperationFailed))?;
        if !matches!(worktree.availability(), WorktreeAvailability::Ready)
            || !matches!(worktree.owner(), WorktreeOwner::Unbound)
        {
            return Err(RpcError::new(
                -32061,
                AppServerErrorName::GitOperationFailed,
            ));
        }
        result(&GitWorktreeResolveResult {
            path: worktree_path(
                &dunce::canonicalize(worktree.dir())
                    .map_err(|_| RpcError::new(-32061, AppServerErrorName::GitOperationFailed))?,
            )?,
        })
    }

    pub(super) fn git_stage(&self, params: &Value) -> Result<Value, RpcError> {
        let params: GitPathsParams = decode(params)?;
        let status = self
            .git_runtime_service()?
            .stage_for(params.repository_id.as_deref(), paths(params.paths)?)
            .map_err(git_error)?;
        result(&GitOperationResult { status })
    }

    pub(super) fn git_unstage(&self, params: &Value) -> Result<Value, RpcError> {
        let params: GitPathsParams = decode(params)?;
        let status = self
            .git_runtime_service()?
            .unstage_for(params.repository_id.as_deref(), paths(params.paths)?)
            .map_err(git_error)?;
        result(&GitOperationResult { status })
    }

    pub(super) fn git_discard_worktree(&self, params: &Value) -> Result<Value, RpcError> {
        let params: GitPathsParams = decode(params)?;
        let status = self
            .git_runtime_service()?
            .discard_worktree_for(params.repository_id.as_deref(), paths(params.paths)?)
            .map_err(git_error)?;
        result(&GitOperationResult { status })
    }

    pub(super) fn git_commit(&self, params: &Value) -> Result<Value, RpcError> {
        let params: GitCommitParams = decode(params)?;
        if params.message.trim().is_empty()
            || params.message.len() > 65_536
            || params.message.contains('\0')
        {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let committed = self
            .git_runtime_service()?
            .commit_for(params.repository_id.as_deref(), params.message)
            .map_err(git_error)?;
        result(&GitCommitResultDto {
            object_id: committed.object_id,
            status: committed.status,
        })
    }

    pub(super) fn git_fetch(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitFetchParams = decode(value)?;
        let status = self
            .git_runtime_service()?
            .fetch_for(
                params.repository_id.as_deref(),
                params.mode.unwrap_or(GitFetchModeDto::All),
            )
            .map_err(git_error)?;
        result(&GitOperationResult { status })
    }

    pub(super) fn git_pull(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitRepositoryParams = decode(value)?;
        let status = self
            .git_runtime_service()?
            .pull_fast_forward_for(params.repository_id.as_deref())
            .map_err(git_error)?;
        result(&GitOperationResult { status })
    }

    pub(super) fn git_push(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitRepositoryParams = decode(value)?;
        let status = self
            .git_runtime_service()?
            .push_for(params.repository_id.as_deref())
            .map_err(git_error)?;
        result(&GitOperationResult { status })
    }
}

fn worktree_path(path: &Path) -> Result<String, RpcError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| RpcError::new(-32061, AppServerErrorName::GitOperationFailed))
}

fn paths(paths: Vec<String>) -> Result<Vec<PathBuf>, RpcError> {
    if paths.is_empty() || paths.len() > 5_000 {
        return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
    }
    let paths = paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    if paths.iter().any(|path| {
        path.as_os_str().is_empty()
            || path.as_os_str().to_string_lossy().contains('\0')
            || path.is_absolute()
            || path
                .components()
                .any(|component| !matches!(component, std::path::Component::Normal(_)))
    }) {
        return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
    }
    Ok(paths)
}

fn validate_object_id(object_id: &str) -> Result<(), RpcError> {
    if !(40..=64).contains(&object_id.len())
        || !object_id.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
    }
    Ok(())
}

fn git_error(error: GitRuntimeError) -> RpcError {
    match error {
        GitRuntimeError::InvalidGraphCursor => {
            RpcError::new(-32602, AppServerErrorName::InvalidParams)
        }
        GitRuntimeError::RepositoryNotFound => {
            RpcError::new(-32602, AppServerErrorName::InvalidParams)
        }
        GitRuntimeError::Boundary
        | GitRuntimeError::Service(GitServiceError::Boundary)
        | GitRuntimeError::Service(GitServiceError::BranchNotFound)
        | GitRuntimeError::Service(GitServiceError::CommitChangeNotFound) => {
            RpcError::new(-32061, AppServerErrorName::GitOperationFailed)
        }
        GitRuntimeError::Service(GitServiceError::Git(GitError::NotAWorkingTree { .. })) => {
            RpcError::new(-32062, AppServerErrorName::GitNotRepository)
        }
        GitRuntimeError::Service(GitServiceError::Git(_)) => {
            RpcError::new(-32061, AppServerErrorName::GitOperationFailed)
        }
        GitRuntimeError::Service(GitServiceError::Runtime) => {
            RpcError::new(-32000, AppServerErrorName::ServerOverloaded)
        }
        GitRuntimeError::Service(GitServiceError::Permission) => {
            RpcError::new(-32060, AppServerErrorName::GitUnavailable)
        }
    }
}
