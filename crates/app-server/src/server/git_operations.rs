use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::core_error;
use super::decode;
use super::result;
use crate::git_service::GitServiceError;
use crate::server::git_runtime::GitRuntimeError;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::git::GitBranchCreateParams;
use ash_app_server_protocol::protocol::git::GitBranchDeleteParams;
use ash_app_server_protocol::protocol::git::GitBranchListResult;
use ash_app_server_protocol::protocol::git::GitBranchSwitchParams;
use ash_app_server_protocol::protocol::git::GitCatalogResult;
use ash_app_server_protocol::protocol::git::GitChangeFileParams;
use ash_app_server_protocol::protocol::git::GitCheckIgnoreCancelParams;
use ash_app_server_protocol::protocol::git::GitCheckIgnoreCancelResult;
use ash_app_server_protocol::protocol::git::GitCheckIgnoreCancelStatusDto;
use ash_app_server_protocol::protocol::git::GitCheckIgnoreParams;
use ash_app_server_protocol::protocol::git::GitCheckIgnoreResult;
use ash_app_server_protocol::protocol::git::GitCloneParams;
use ash_app_server_protocol::protocol::git::GitCloneResult;
use ash_app_server_protocol::protocol::git::GitCommandDto;
use ash_app_server_protocol::protocol::git::GitCommandOutcomeDto;
use ash_app_server_protocol::protocol::git::GitCommandParams;
use ash_app_server_protocol::protocol::git::GitCommandResult;
use ash_app_server_protocol::protocol::git::GitCommitChangesParams;
use ash_app_server_protocol::protocol::git::GitCommitDetailsResult;
use ash_app_server_protocol::protocol::git::GitCommitFileParams;
use ash_app_server_protocol::protocol::git::GitCommitMessageResult;
use ash_app_server_protocol::protocol::git::GitCommitModeDto;
use ash_app_server_protocol::protocol::git::GitCommitParams;
use ash_app_server_protocol::protocol::git::GitCommitResult as GitCommitResultDto;
use ash_app_server_protocol::protocol::git::GitCommitScopeDto;
use ash_app_server_protocol::protocol::git::GitCommitSignoffDto;
use ash_app_server_protocol::protocol::git::GitCommitStatisticsDto;
use ash_app_server_protocol::protocol::git::GitCompareChangesParams;
use ash_app_server_protocol::protocol::git::GitComparisonModeDto;
use ash_app_server_protocol::protocol::git::GitCompleteConflictParams;
use ash_app_server_protocol::protocol::git::GitConflictFileParams;
use ash_app_server_protocol::protocol::git::GitFetchModeDto;
use ash_app_server_protocol::protocol::git::GitFetchParams;
use ash_app_server_protocol::protocol::git::GitGraphParams;
use ash_app_server_protocol::protocol::git::GitHeadDto;
use ash_app_server_protocol::protocol::git::GitHistoryResult;
use ash_app_server_protocol::protocol::git::GitIndexDiffResult;
use ash_app_server_protocol::protocol::git::GitIndexEditParams;
use ash_app_server_protocol::protocol::git::GitIndexHunkDto;
use ash_app_server_protocol::protocol::git::GitIndexSelectionDto;
use ash_app_server_protocol::protocol::git::GitIntegrationDto;
use ash_app_server_protocol::protocol::git::GitNamedRefDto;
use ash_app_server_protocol::protocol::git::GitOperationResult;
use ash_app_server_protocol::protocol::git::GitPathsParams;
use ash_app_server_protocol::protocol::git::GitRepositoryParams;
use ash_app_server_protocol::protocol::git::GitStashDto;
use ash_app_server_protocol::protocol::git::GitStashModeDto;
use ash_app_server_protocol::protocol::git::GitWorktreeCreateParams;
use ash_app_server_protocol::protocol::git::GitWorktreeCreateResult;
use ash_app_server_protocol::protocol::git::GitWorktreeDeleteMode;
use ash_app_server_protocol::protocol::git::GitWorktreeDeleteParams;
use ash_app_server_protocol::protocol::git::GitWorktreeDto;
use ash_app_server_protocol::protocol::git::GitWorktreeListResult;
use ash_app_server_protocol::protocol::git::GitWorktreeResolveParams;
use ash_app_server_protocol::protocol::git::GitWorktreeResolveResult;
use ash_app_server_protocol::protocol::git::GitWorktreeStateDto;
use ash_async_utils::CancellationToken;
use ash_async_utils::FutureCancellationExt;
use ash_git::GitClient;
use ash_git::GitError;
use ash_protocol::HookEvent;
use core_api::HookEventDecision;
use core_api::HookEventRequest;
use core_api::HookEventScope;
use serde_json::Value;
use std::num::NonZeroUsize;
use std::path::Path;
use std::path::PathBuf;
use worktree::WorktreeAvailability;
use worktree::WorktreeOwner;
use worktree::WorktreeSelector;

const MAX_GIT_GRAPH_PAGE_SIZE: usize = 1000;

impl AppServer {
    pub(super) fn git_catalog(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitRepositoryParams = decode(value)?;
        let catalog = self
            .git_runtime_service()?
            .catalog_for(params.repository_id.as_deref())
            .map_err(git_error)?;
        result(&GitCatalogResult {
            tags: catalog
                .tags
                .into_iter()
                .map(|(name, object_id)| GitNamedRefDto { name, object_id })
                .collect(),
            stashes: catalog
                .stashes
                .into_iter()
                .map(|(object_id, subject)| GitStashDto { object_id, subject })
                .collect(),
            remotes: catalog.remotes,
            upstream_remote: catalog.upstream_remote,
            operation: catalog.operation.map(integration_dto),
        })
    }

    pub(super) fn git_command(
        &self,
        value: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: GitCommandParams = decode(value)?;
        let command = command(params.command);
        let (status, outcome, operation) = self
            .git_runtime_service()?
            .command_for(params.repository_id.as_deref(), &command, cancellation)
            .map_err(git_error)?;
        result(&GitCommandResult {
            status,
            operation: operation.map(integration_dto),
            outcome: match outcome {
                ash_git::GitCommandOutcome::Completed => GitCommandOutcomeDto::Completed,
                ash_git::GitCommandOutcome::Conflicted => GitCommandOutcomeDto::Conflicted,
            },
        })
    }

    pub(super) fn git_index_diff(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitChangeFileParams = decode(value)?;
        let path = paths(vec![params.path])?.pop().expect("validated path");
        let diff = self
            .git_runtime_service()?
            .index_diff_for(
                params.repository_id.as_deref(),
                &path,
                comparison(params.comparison),
            )
            .map_err(git_error)?;
        let hunks = diff
            .document
            .hunks()
            .iter()
            .enumerate()
            .map(|(index, hunk)| GitIndexHunkDto {
                index,
                old_start: hunk.old_start(),
                old_count: hunk.old_count(),
                new_start: hunk.new_start(),
                new_count: hunk.new_count(),
                preview: diff
                    .document
                    .rows_for_hunk(*hunk)
                    .iter()
                    .filter(|row| row.kind() != ash_diff::DiffRowKind::Context)
                    .take(6)
                    .map(|row| row.new_text().or_else(|| row.old_text()).unwrap_or(""))
                    .collect::<Vec<_>>()
                    .join("\n"),
            })
            .collect();
        result(&GitIndexDiffResult {
            original: diff.original,
            modified: diff.modified,
            hunks,
        })
    }

    pub(super) fn git_index_edit(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitIndexEditParams = decode(value)?;
        let request = ash_git::GitIndexEdit {
            path: paths(vec![params.path])?.pop().expect("validated path"),
            comparison: comparison(params.comparison),
            expected_original: params.expected_original,
            expected_modified: params.expected_modified,
            selection: match params.selection {
                GitIndexSelectionDto::Hunk { index } => ash_git::GitIndexSelection::Hunk { index },
                GitIndexSelectionDto::Lines { start, end } => {
                    ash_git::GitIndexSelection::Lines { start, end }
                }
            },
        };
        let status = self
            .git_runtime_service()?
            .index_edit_for(params.repository_id.as_deref(), &request)
            .map_err(git_error)?;
        result(&GitOperationResult { status })
    }

    pub(super) fn git_clone(
        &self,
        connection: &ConnectionState,
        value: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        if !connection.allows_product_host_capabilities() {
            return Err(RpcError::new(
                -32073,
                AppServerErrorName::PermissionRequired,
            ));
        }
        let params: GitCloneParams = decode(value)?;
        let parent = Path::new(&params.parent_path);
        if !parent.is_absolute() {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| RpcError::new(-32000, AppServerErrorName::ServerOverloaded))?;
        let path = runtime
            .block_on(
                GitClient::system()
                    .clone_repository(&params.url, parent)
                    .with_cancellation(cancellation.clone()),
            )
            .map_err(|_| RpcError::new(-32800, AppServerErrorName::RequestCancelled))?
            .map_err(|_| RpcError::new(-32061, AppServerErrorName::GitOperationFailed))?;
        result(&GitCloneResult {
            repository_path: path.to_string_lossy().into_owned(),
        })
    }

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

    pub(super) fn git_check_ignore(
        &self,
        value: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: GitCheckIgnoreParams = decode(value)?;
        let paths = paths(params.paths)?;
        let ignored = self
            .git_runtime_service()?
            .check_ignore_for(params.repository_id.as_deref(), &paths, cancellation)
            .map_err(git_error)?;
        let ignored_paths = ignored
            .iter()
            .map(|path| worktree_path(path))
            .collect::<Result<Vec<_>, _>>()?;
        result(&GitCheckIgnoreResult { ignored_paths })
    }

    pub(super) fn git_check_ignore_cancel(
        &self,
        connection: &ConnectionState,
        value: &Value,
    ) -> Result<Value, RpcError> {
        use super::request_serialization::RequestCancelStatus;
        let params: GitCheckIgnoreCancelParams = decode(value)?;
        if params.operation_id.is_empty() || params.operation_id.chars().count() > 128 {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let status = match self
            .request_cancellations
            .cancel_operation(connection.connection_id, params.operation_id)
        {
            RequestCancelStatus::Requested => GitCheckIgnoreCancelStatusDto::Requested,
            RequestCancelStatus::AlreadyRequested => {
                GitCheckIgnoreCancelStatusDto::AlreadyRequested
            }
            RequestCancelStatus::Completed => GitCheckIgnoreCancelStatusDto::Completed,
        };
        self.request_scheduler.cancel_waiting_requests();
        result(&GitCheckIgnoreCancelResult { status })
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

    pub(super) fn git_compare_changes(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitCompareChangesParams = decode(value)?;
        validate_object_id(&params.object_id)?;
        if params.base_reference.is_empty()
            || params.base_reference.len() > 1024
            || params.base_reference.contains('\0')
        {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let mode = match params.mode {
            GitComparisonModeDto::Direct => ash_git::GitComparisonMode::Direct,
            GitComparisonModeDto::MergeBase => ash_git::GitComparisonMode::MergeBase,
        };
        result(
            &self
                .git_runtime_service()?
                .compare_changes_for(
                    params.repository_id.as_deref(),
                    &params.object_id,
                    &params.base_reference,
                    mode,
                )
                .map_err(git_error)?,
        )
    }

    pub(super) fn git_commit_message(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitCommitChangesParams = decode(value)?;
        validate_object_id(&params.object_id)?;
        let message = self
            .git_runtime_service()?
            .commit_message_for(params.repository_id.as_deref(), &params.object_id)
            .map_err(git_error)?;
        result(&GitCommitMessageResult { message })
    }

    pub(super) fn git_commit_details(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitCommitChangesParams = decode(value)?;
        validate_object_id(&params.object_id)?;
        let details = self
            .git_runtime_service()?
            .commit_details_for(params.repository_id.as_deref(), &params.object_id)
            .map_err(git_error)?;
        result(&GitCommitDetailsResult {
            author_name: details.author_name,
            author_email: details.author_email,
            timestamp_seconds: details.timestamp_seconds,
            message: details.message,
            statistics: GitCommitStatisticsDto {
                files: details.statistics.files,
                additions: details.statistics.additions,
                deletions: details.statistics.deletions,
            },
        })
    }

    pub(super) fn git_commit_file(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitCommitFileParams = decode(value)?;
        validate_object_id(&params.object_id)?;
        if let Some(base) = params.parent_object_id.as_deref() {
            validate_object_id(base)?;
        }
        let path = paths(vec![params.path])?
            .pop()
            .expect("validated commit file path");
        result(
            &self
                .git_runtime_service()?
                .commit_file_for(
                    params.repository_id.as_deref(),
                    &params.object_id,
                    &path,
                    params.parent_object_id.as_deref(),
                )
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

    pub(super) fn git_conflict_file(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitConflictFileParams = decode(value)?;
        let path = paths(vec![params.path])?
            .pop()
            .expect("validated conflict file path");
        result(
            &self
                .git_runtime_service()?
                .conflict_file_for(params.repository_id.as_deref(), &path)
                .map_err(git_error)?,
        )
    }

    pub(super) fn git_complete_conflict(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitCompleteConflictParams = decode(value)?;
        if let ash_app_server_protocol::protocol::git::GitConflictResolutionDto::Edited { text } =
            &params.resolution
            && text.len() > 2 * 1024 * 1024
        {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let path = paths(vec![params.path])?
            .pop()
            .expect("validated conflict path");
        let status = self
            .git_runtime_service()?
            .complete_conflict_for(
                params.repository_id.as_deref(),
                &path,
                params.expected_stage_ids,
                params.expected_result_object_id,
                params.resolution,
            )
            .map_err(git_error)?;
        result(&GitOperationResult { status })
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

    pub(super) fn git_branch_delete(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitBranchDeleteParams = decode(value)?;
        if params.name.trim().is_empty() || params.name.len() > 1024 || params.name.contains('\0') {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let branches = self
            .git_runtime_service()?
            .delete_branch_for(params.repository_id.as_deref(), &params.name)
            .map_err(git_error)?;
        result(&GitBranchListResult { branches })
    }

    pub(super) fn git_worktree_create(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitWorktreeCreateParams = decode(value)?;
        if let HookEventDecision::Deny { reason } = self.emit_hook_event(&HookEventRequest {
            event: HookEvent::WorktreeCreate,
            scope: HookEventScope::User,
            subject: Some(params.name.clone()),
            tool_name: None,
        })? {
            return Err(core_error(core_api::CoreError::Policy(reason)));
        }
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
        result(&self.git_worktree_list_result(params.repository_id.as_deref())?)
    }

    pub(super) fn git_worktree_delete(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitWorktreeDeleteParams = decode(value)?;
        if params.checkout_root.is_empty() || params.checkout_root.len() > 32_768 {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        if let HookEventDecision::Deny { reason } = self.emit_hook_event(&HookEventRequest {
            event: HookEvent::WorktreeRemove,
            scope: HookEventScope::User,
            subject: Some(params.checkout_root.clone()),
            tool_name: None,
        })? {
            return Err(core_error(core_api::CoreError::Policy(reason)));
        }
        let source = self
            .git_runtime_service()?
            .mutable_source_for(params.repository_id.as_deref())
            .map_err(git_error)?;
        let dirs = self
            .dir_services
            .as_ref()
            .ok_or_else(|| RpcError::new(-32060, AppServerErrorName::GitUnavailable))?;
        match params.mode {
            GitWorktreeDeleteMode::Unbound => {
                let checkout_root = dunce::canonicalize(&params.checkout_root)
                    .map_err(|_| RpcError::new(-32061, AppServerErrorName::GitOperationFailed))?;
                dirs.release_search(&checkout_root)
                    .map_err(|_| RpcError::new(-32061, AppServerErrorName::GitOperationFailed))?;
                dirs.runtime
                    .block_on(
                        dirs.worktrees
                            .remove_unbound(&source, Path::new(&params.checkout_root)),
                    )
                    .map_err(|_| RpcError::new(-32061, AppServerErrorName::GitOperationFailed))?;
            }
            GitWorktreeDeleteMode::SessionAndWorktrees => {
                let checkout_root = dunce::canonicalize(&params.checkout_root)
                    .map_err(|_| RpcError::new(-32061, AppServerErrorName::GitOperationFailed))?;
                let worktree = dirs
                    .runtime
                    .block_on(dirs.worktrees.list(&source))
                    .map_err(|_| RpcError::new(-32061, AppServerErrorName::GitOperationFailed))?
                    .into_iter()
                    .find(|worktree| worktree.checkout_root() == checkout_root)
                    .ok_or_else(|| RpcError::new(-32061, AppServerErrorName::GitOperationFailed))?;
                if worktree.is_current() {
                    return Err(RpcError::new(
                        -32061,
                        AppServerErrorName::GitOperationFailed,
                    ));
                }
                let thread_id = worktree
                    .owner_thread_id()
                    .ok_or_else(|| RpcError::new(-32061, AppServerErrorName::GitOperationFailed))?
                    .to_owned();
                self.delete_worktree_session(&thread_id, &params.command_id)?;
            }
        }
        result(&self.git_worktree_list_result(params.repository_id.as_deref())?)
    }

    fn git_worktree_list_result(
        &self,
        repository_id: Option<&str>,
    ) -> Result<GitWorktreeListResult, RpcError> {
        let source = self
            .git_runtime_service()?
            .readable_source_for(repository_id)
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
                let state = match (worktree.availability(), worktree.owner()) {
                    (WorktreeAvailability::Prunable { .. }, _) => GitWorktreeStateDto::Prunable,
                    (_, WorktreeOwner::Thread(_)) => GitWorktreeStateDto::ThreadOwned,
                    (WorktreeAvailability::Locked { .. }, _) => GitWorktreeStateDto::Locked,
                    (_, WorktreeOwner::Invalid) => GitWorktreeStateDto::Invalid,
                    (_, WorktreeOwner::Unbound) if !worktree.dir().is_dir() => {
                        GitWorktreeStateDto::MissingDirectory
                    }
                    (_, WorktreeOwner::Unbound) => GitWorktreeStateDto::Ready,
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
        Ok(GitWorktreeListResult { worktrees })
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
        let request = ash_git::GitCommitRequest::new(params.message)
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let request = match params.scope.unwrap_or(GitCommitScopeDto::Staged) {
            GitCommitScopeDto::Staged => request,
            GitCommitScopeDto::Tracked => request.with_tracked_changes(),
            GitCommitScopeDto::IncludeUntracked => request.with_untracked_changes(),
        };
        let request = match params.mode.unwrap_or(GitCommitModeDto::Create) {
            GitCommitModeDto::Create => request,
            GitCommitModeDto::Amend => request.amend(),
        };
        let request = match params.signoff.unwrap_or(GitCommitSignoffDto::None) {
            GitCommitSignoffDto::None => request,
            GitCommitSignoffDto::Add => request.sign_off(),
        };
        let request = match params.expected_head {
            Some(head) => {
                let head = match head {
                    GitHeadDto::Branch {
                        name, object_id, ..
                    } => ash_git::GitHead::Branch {
                        name,
                        object_id,
                        upstream: None,
                    },
                    GitHeadDto::Detached { object_id } => ash_git::GitHead::Detached { object_id },
                    GitHeadDto::Unborn { name } => ash_git::GitHead::Unborn { name },
                };
                request
                    .with_expected_head(head)
                    .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?
            }
            None => request,
        };
        let committed = self
            .git_runtime_service()?
            .commit_for(params.repository_id.as_deref(), request)
            .map_err(git_error)?;
        result(&GitCommitResultDto {
            object_id: committed.object_id,
            status: committed.status,
        })
    }

    pub(super) fn git_fetch(
        &self,
        value: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: GitFetchParams = decode(value)?;
        let status = self
            .git_runtime_service()?
            .fetch_for(
                params.repository_id.as_deref(),
                params.mode.unwrap_or(GitFetchModeDto::All),
                cancellation,
            )
            .map_err(git_error)?;
        result(&GitOperationResult { status })
    }

    pub(super) fn git_pull(
        &self,
        value: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: GitRepositoryParams = decode(value)?;
        let status = self
            .git_runtime_service()?
            .pull_fast_forward_for(params.repository_id.as_deref(), cancellation)
            .map_err(git_error)?;
        result(&GitOperationResult { status })
    }

    pub(super) fn git_push(
        &self,
        value: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: GitRepositoryParams = decode(value)?;
        let status = self
            .git_runtime_service()?
            .push_for(params.repository_id.as_deref(), cancellation)
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

pub(super) fn git_error(error: GitRuntimeError) -> RpcError {
    match error {
        GitRuntimeError::Service(GitServiceError::Cancelled) => {
            RpcError::new(-32800, AppServerErrorName::RequestCancelled)
        }
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
        GitRuntimeError::Service(GitServiceError::ConflictChanged) => {
            RpcError::new(-32064, AppServerErrorName::GitConflictChanged)
        }
        GitRuntimeError::Service(GitServiceError::Git(GitError::IndexChanged)) => {
            RpcError::new(-32065, AppServerErrorName::GitIndexChanged)
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

fn integration_dto(operation: ash_git::GitIntegration) -> GitIntegrationDto {
    match operation {
        ash_git::GitIntegration::Merge => GitIntegrationDto::Merge,
        ash_git::GitIntegration::Rebase => GitIntegrationDto::Rebase,
        ash_git::GitIntegration::CherryPick => GitIntegrationDto::CherryPick,
    }
}
fn integration(operation: GitIntegrationDto) -> ash_git::GitIntegration {
    match operation {
        GitIntegrationDto::Merge => ash_git::GitIntegration::Merge,
        GitIntegrationDto::Rebase => ash_git::GitIntegration::Rebase,
        GitIntegrationDto::CherryPick => ash_git::GitIntegration::CherryPick,
    }
}
fn comparison(
    value: ash_app_server_protocol::protocol::git::GitChangeFileComparisonDto,
) -> ash_git::GitChangeFileComparison {
    match value {
        ash_app_server_protocol::protocol::git::GitChangeFileComparisonDto::Staged => {
            ash_git::GitChangeFileComparison::Staged
        }
        ash_app_server_protocol::protocol::git::GitChangeFileComparisonDto::Unstaged => {
            ash_git::GitChangeFileComparison::Unstaged
        }
    }
}
fn command(command: GitCommandDto) -> ash_git::GitCommand {
    match command {
        GitCommandDto::FetchAndCheckout {
            remote,
            remote_identity,
            reference,
            object_id,
            name,
        } => ash_git::GitCommand::FetchAndCheckout {
            remote,
            remote_identity,
            reference,
            object_id,
            name,
        },
        GitCommandDto::PushBranch {
            remote,
            remote_identity,
            name,
            branch,
            expected_head,
        } => ash_git::GitCommand::PushBranch {
            remote,
            remote_identity,
            name,
            branch,
            expected_head,
        },
        GitCommandDto::CreateBranchAt { name, object_id } => {
            ash_git::GitCommand::CreateBranchAt { name, object_id }
        }
        GitCommandDto::CheckoutDetached { object_id } => {
            ash_git::GitCommand::CheckoutDetached { object_id }
        }
        GitCommandDto::CheckoutRemoteBranch { name, reference } => {
            ash_git::GitCommand::CheckoutRemoteBranch { name, reference }
        }
        GitCommandDto::RenameBranch { name, new_name } => {
            ash_git::GitCommand::RenameBranch { name, new_name }
        }
        GitCommandDto::DeleteRemoteBranch { remote, name } => {
            ash_git::GitCommand::DeleteRemoteBranch { remote, name }
        }
        GitCommandDto::Merge { reference } => ash_git::GitCommand::Merge { reference },
        GitCommandDto::Rebase { reference } => ash_git::GitCommand::Rebase { reference },
        GitCommandDto::CherryPick {
            reference,
            mainline,
        } => ash_git::GitCommand::CherryPick {
            reference,
            mainline,
        },
        GitCommandDto::Continue { operation } => ash_git::GitCommand::Continue {
            operation: integration(operation),
        },
        GitCommandDto::Abort { operation } => ash_git::GitCommand::Abort {
            operation: integration(operation),
        },
        GitCommandDto::Stash { message, mode } => ash_git::GitCommand::Stash {
            message,
            mode: match mode {
                GitStashModeDto::Tracked => ash_git::GitStashMode::Tracked,
                GitStashModeDto::IncludeUntracked => ash_git::GitStashMode::IncludeUntracked,
            },
        },
        GitCommandDto::ApplyStash { object_id } => ash_git::GitCommand::ApplyStash { object_id },
        GitCommandDto::PopStash { object_id } => ash_git::GitCommand::PopStash { object_id },
        GitCommandDto::DropStash { object_id } => ash_git::GitCommand::DropStash { object_id },
        GitCommandDto::CreateTag { name, reference } => {
            ash_git::GitCommand::CreateTag { name, reference }
        }
        GitCommandDto::DeleteTag { name } => ash_git::GitCommand::DeleteTag { name },
        GitCommandDto::AddRemote { name, url } => ash_git::GitCommand::AddRemote { name, url },
        GitCommandDto::RemoveRemote { name } => ash_git::GitCommand::RemoveRemote { name },
        GitCommandDto::Amend { message } => ash_git::GitCommand::Amend { message },
        GitCommandDto::UndoCommit { expected_head } => {
            ash_git::GitCommand::UndoCommit { expected_head }
        }
    }
}
