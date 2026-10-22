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
use ash_app_server_protocol::protocol::git::GitCloneCancelParams;
use ash_app_server_protocol::protocol::git::GitCloneCancelResult;
use ash_app_server_protocol::protocol::git::GitCloneParams;
use ash_app_server_protocol::protocol::git::GitCloneResult;
use ash_app_server_protocol::protocol::git::GitCloneToParams;
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
use ash_app_server_protocol::protocol::git::GitCommitSigningDto;
use ash_app_server_protocol::protocol::git::GitCommitSignoffDto;
use ash_app_server_protocol::protocol::git::GitCommitStatisticsDto;
use ash_app_server_protocol::protocol::git::GitCompareChangesParams;
use ash_app_server_protocol::protocol::git::GitComparisonModeDto;
use ash_app_server_protocol::protocol::git::GitCompleteConflictParams;
use ash_app_server_protocol::protocol::git::GitConflictFileParams;
use ash_app_server_protocol::protocol::git::GitEmptyCommitPolicyDto;
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
use ash_app_server_protocol::protocol::git::GitPullModeDto;
use ash_app_server_protocol::protocol::git::GitPullParams;
use ash_app_server_protocol::protocol::git::GitRepositoryParams;
use ash_app_server_protocol::protocol::git::GitStashDto;
use ash_app_server_protocol::protocol::git::GitStashModeDto;
use ash_app_server_protocol::protocol::git::GitTextDiffParams;
use ash_app_server_protocol::protocol::git::GitTextDiffProjectionDto;
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
use ash_git::GitError;
use ash_git::GitPullMode;
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

/// Coordinates the existing owners needed by the git adapter.
/// This contract deliberately exposes no server object or unrestricted service registry.
pub(super) trait GitRequestProcessorContext: Send + Sync {
    fn delete_worktree_session(
        &self,
        owner_thread_id: &str,
        command_id: &ash_protocol::CommandId,
    ) -> Result<(), super::RpcError>;
    fn emit_hook_event(
        &self,
        request: &core_api::HookEventRequest,
    ) -> Result<core_api::HookEventDecision, super::RpcError>;
    fn session_dir_authorization(
        &self,
        session_id: &ash_protocol::SessionId,
        root: &Path,
        permission: ash_file_access::Permission,
    ) -> Result<ash_file_access::Authorization, RpcError>;
    fn git_runtime_service(
        &self,
    ) -> Result<std::sync::Arc<super::git_runtime::GitRuntime>, super::RpcError>;
}

pub(super) struct GitRequestProcessor<'ctx, C: GitRequestProcessorContext + ?Sized> {
    context: &'ctx C,
    env_runtime: &'ctx std::sync::Arc<std::sync::RwLock<super::environment_runtime::EnvRuntime>>,
    env_runtime_gate: &'ctx std::sync::Arc<std::sync::Mutex<()>>,
    config: &'ctx Option<super::Arc<super::ConfigStore>>,
    dir_services: &'ctx Option<super::Arc<super::thread_dirs::ThreadDirs>>,
    git_attribution_policy:
        &'ctx Option<super::Arc<dyn git_attribution::GitAttributionPolicySource>>,
    git_turn_changes:
        &'ctx Option<super::Arc<super::git_turn_changes_runtime::GitTurnChangesRuntime>>,
    request_cancellations: &'ctx super::RequestCancellationRegistry,
    request_scheduler: &'ctx super::RequestScheduler,
}

impl<'ctx, C: GitRequestProcessorContext + ?Sized> GitRequestProcessor<'ctx, C> {
    pub(super) fn new(
        context: &'ctx C,
        env_runtime: &'ctx std::sync::Arc<
            std::sync::RwLock<super::environment_runtime::EnvRuntime>,
        >,
        env_runtime_gate: &'ctx std::sync::Arc<std::sync::Mutex<()>>,
        config: &'ctx Option<super::Arc<super::ConfigStore>>,
        dir_services: &'ctx Option<super::Arc<super::thread_dirs::ThreadDirs>>,
        git_attribution_policy: &'ctx Option<
            super::Arc<dyn git_attribution::GitAttributionPolicySource>,
        >,
        git_turn_changes: &'ctx Option<
            super::Arc<super::git_turn_changes_runtime::GitTurnChangesRuntime>,
        >,
        request_cancellations: &'ctx super::RequestCancellationRegistry,
        request_scheduler: &'ctx super::RequestScheduler,
    ) -> Self {
        Self {
            context,
            env_runtime,
            env_runtime_gate,
            config,
            dir_services,
            git_attribution_policy,
            git_turn_changes,
            request_cancellations,
            request_scheduler,
        }
    }
}

impl<'ctx, C: GitRequestProcessorContext + ?Sized> GitRequestProcessor<'ctx, C> {
    pub(super) fn git_ai_contribution(&self, value: &Value) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::git::GitAIContributionParams;
        use ash_app_server_protocol::protocol::git::GitAIContributionResult;
        let params: GitAIContributionParams = decode(value)?;
        if params.editor_evidence.len() > 100
            || params
                .editor_evidence
                .iter()
                .map(|entry| entry.text.len())
                .sum::<usize>()
                > 256 * 1024
        {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let evidence = params
            .editor_evidence
            .into_iter()
            .map(|entry| Ok((paths(vec![entry.path])?.remove(0), entry.text)))
            .collect::<Result<Vec<_>, RpcError>>()?;
        let scope = match params.scope {
            GitCommitScopeDto::Staged => crate::git_service::GitCommitScope::Staged,
            GitCommitScopeDto::Tracked => crate::git_service::GitCommitScope::Tracked,
            GitCommitScopeDto::IncludeUntracked => {
                crate::git_service::GitCommitScope::IncludeUntracked
            }
        };
        let (root, present) = self
            .context
            .git_runtime_service()?
            .ai_contribution_for(
                params.repository_id.as_deref(),
                self.git_turn_changes
                    .as_ref()
                    .map(|runtime| runtime.store().as_ref()),
                scope,
                &evidence,
            )
            .map_err(git_error)?;
        let co_author = if present {
            self.git_attribution_policy
                .as_ref()
                .map(|policy| policy.repository_co_author(&root))
                .transpose()
                .map_err(|_| RpcError::new(-32603, AppServerErrorName::InternalError))?
                .flatten()
        } else {
            None
        };
        result(&GitAIContributionResult { present, co_author })
    }
    pub(super) fn git_review_removal(&self, value: &Value) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::git::GitRemovalEntryDto;
        use ash_app_server_protocol::protocol::git::GitRemovalFileDto;
        use ash_app_server_protocol::protocol::git::GitRemovalReviewResult;
        let params: GitPathsParams = decode(value)?;
        let review = self
            .context
            .git_runtime_service()?
            .review_removal_for(params.repository_id.as_deref(), paths(params.paths)?)
            .map_err(git_error)?;
        result(&GitRemovalReviewResult {
            head: super::git_runtime::head(&review.head),
            entries: review
                .entries
                .into_iter()
                .map(|entry| {
                    Ok(GitRemovalEntryDto {
                        file: GitRemovalFileDto {
                            path: worktree_path(&entry.file.path)?,
                            revision: entry.file.revision,
                        },
                        committed: entry.committed,
                        changed: entry.changed,
                    })
                })
                .collect::<Result<Vec<_>, RpcError>>()?,
        })
    }
    pub(super) fn git_remove_files(&self, value: &Value) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::git::GitRemovalModeDto;
        use ash_app_server_protocol::protocol::git::GitRemoveFilesParams;
        let params: GitRemoveFilesParams = decode(value)?;
        if params.entries.is_empty()
            || params.entries.len() > 5000
            || params.entries.iter().any(|entry| {
                entry.revision.len() != 64
                    || !entry.revision.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let entries = params
            .entries
            .into_iter()
            .map(|entry| {
                Ok(ash_file_system::FileRemoval {
                    path: paths(vec![entry.path])?.remove(0),
                    revision: entry.revision,
                })
            })
            .collect::<Result<Vec<_>, RpcError>>()?;
        let head = match params.expected_head {
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
        let mode = match params.mode {
            GitRemovalModeDto::Trash => ash_file_system::FileRemovalMode::Trash,
            GitRemovalModeDto::Permanent => ash_file_system::FileRemovalMode::Permanent,
        };
        let status = self
            .context
            .git_runtime_service()?
            .remove_files_for(params.repository_id.as_deref(), entries, mode, &head)
            .map_err(git_error)?;
        result(&GitOperationResult { status })
    }
    pub(super) fn git_transport(
        &self,
        value: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        use crate::git_service::GitRemoteMutation;
        use ash_app_server_protocol::protocol::git::GitTransportOperationDto;
        use ash_app_server_protocol::protocol::git::GitTransportOutcomeDto;
        use ash_app_server_protocol::protocol::git::GitTransportParams;
        use ash_app_server_protocol::protocol::git::GitTransportResult;
        let params: GitTransportParams = decode(value)?;
        let target = match &params.operation {
            GitTransportOperationDto::Push {
                expected_head:
                    GitHeadDto::Branch {
                        name,
                        object_id,
                        upstream: Some(upstream),
                    },
            }
            | GitTransportOperationDto::Pull {
                expected_head:
                    Some(GitHeadDto::Branch {
                        name,
                        object_id,
                        upstream: Some(upstream),
                    }),
                ..
            } => Some(ash_git::GitUpstreamTarget {
                branch: name.clone(),
                object_id: object_id.clone(),
                upstream: upstream.name.clone(),
            }),
            GitTransportOperationDto::Push { .. }
            | GitTransportOperationDto::Pull {
                expected_head: Some(_),
                ..
            } => {
                return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
            }
            GitTransportOperationDto::Fetch { .. }
            | GitTransportOperationDto::Pull {
                expected_head: None,
                ..
            } => None,
        };
        let operation = match &params.operation {
            GitTransportOperationDto::Fetch { mode } => match mode {
                GitFetchModeDto::Default => GitRemoteMutation::FetchDefault,
                GitFetchModeDto::All => GitRemoteMutation::Fetch,
                GitFetchModeDto::Remote(name) => GitRemoteMutation::FetchRemote(name),
            },
            GitTransportOperationDto::Pull { mode, .. } => match target.as_ref() {
                Some(target) => {
                    GitRemoteMutation::PullReviewed(self.resolve_pull_mode(*mode)?, target)
                }
                None => GitRemoteMutation::Pull(self.resolve_pull_mode(*mode)?),
            },
            GitTransportOperationDto::Push { .. } => {
                GitRemoteMutation::PushReviewed(target.as_ref().expect("validated push target"))
            }
        };
        let runtime = self.context.git_runtime_service()?;
        let outcome = runtime.transport_for(
            params.repository_id.as_deref(),
            operation,
            transport_options(params.transport),
            cancellation,
        );
        let (status, outcome) = match outcome {
            Ok(status) => (status, GitTransportOutcomeDto::Completed),
            Err(GitRuntimeError::Service(GitServiceError::Git(GitError::TagConflict { tags }))) => {
                (
                    runtime
                        .status_for(params.repository_id.as_deref())
                        .map_err(git_error)?,
                    GitTransportOutcomeDto::TagConflict { tags },
                )
            }
            Err(error) => return Err(git_error(error)),
        };
        result(&GitTransportResult { status, outcome })
    }
    fn resolve_pull_mode(&self, mode: GitPullModeDto) -> Result<GitPullMode, RpcError> {
        Ok(match mode {
            GitPullModeDto::Configured => GitPullMode::Configured,
            GitPullModeDto::Rebase => GitPullMode::Rebase,
            GitPullModeDto::Sync => {
                let snapshot = self
                    .config
                    .as_ref()
                    .ok_or_else(|| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))?
                    .read_snapshot()
                    .map_err(super::config_operations::config_error)?;
                if snapshot.values.git.rebase_when_sync {
                    GitPullMode::Rebase
                } else {
                    GitPullMode::Configured
                }
            }
        })
    }

    pub(super) fn git_version(&self, value: &Value) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::git::GitInstallationDto;
        use ash_app_server_protocol::protocol::git::GitVersionResult;
        let _: GitRepositoryParams = decode(value)?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| RpcError::new(-32603, AppServerErrorName::InternalError))?;
        let installation = match runtime
            .block_on(crate::git_service::current_client().version())
            .and_then(|version| {
                version.check_supported()?;
                Ok(version)
            }) {
            Ok(version) => GitInstallationDto::Available {
                version: version.display,
            },
            Err(GitError::Io { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
                GitInstallationDto::Missing
            }
            Err(GitError::UnsupportedVersion { installed }) => GitInstallationDto::Unsupported {
                version: installed,
                minimum_version: ash_git::GitVersion::minimum_supported(),
            },
            Err(error) => {
                return Err(git_error(GitRuntimeError::Service(GitServiceError::Git(
                    error,
                ))));
            }
        };
        result(&GitVersionResult { installation })
    }
    pub(super) fn git_pull_preflight(&self, value: &Value) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::git::GitPullPreflightResult;
        let params: GitRepositoryParams = decode(value)?;
        result(&GitPullPreflightResult {
            upstream_rewritten: self
                .context
                .git_runtime_service()?
                .pull_upstream_was_rewritten_for(params.repository_id.as_deref())
                .map_err(git_error)?,
        })
    }

    pub(super) fn git_blame(&self, value: &Value) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::git::{GitBlameParams, GitBlameResult};
        let params: GitBlameParams = decode(value)?;
        let path = paths(vec![params.path])?.remove(0);
        let line = self
            .context
            .git_runtime_service()?
            .blame_for(
                params.repository_id.as_deref(),
                &path,
                params.line,
                params.ignore_whitespace,
                params.contents.as_deref(),
            )
            .map_err(git_error)?;
        result(&GitBlameResult {
            object_id: line.object_id,
            author_name: line.author_name,
            author_email: line.author_email,
            author_time: line.author_time,
            subject: line.subject,
        })
    }
    pub(super) fn git_file_history(&self, value: &Value) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::git::{
            GitFileHistoryItemDto, GitFileHistoryParams, GitFileHistoryResult,
        };
        let params: GitFileHistoryParams = decode(value)?;
        let path = paths(vec![params.path])?.remove(0);
        let limit = params.limit.unwrap_or(50);
        if !(1..=1000).contains(&limit)
            || params
                .cursor
                .as_ref()
                .is_some_and(|cursor| cursor.len() > 32768)
        {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let cursor = params
            .cursor
            .as_deref()
            .map(serde_json::from_str::<ash_git::GitFileHistoryCursor>)
            .transpose()
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let page = self
            .context
            .git_runtime_service()?
            .file_history_for(
                params.repository_id.as_deref(),
                &path,
                NonZeroUsize::new(limit).expect("validated file history page size"),
                cursor,
            )
            .map_err(git_error)?;
        result(&GitFileHistoryResult {
            items: page
                .items
                .into_iter()
                .map(|item| {
                    Ok(GitFileHistoryItemDto {
                        path: worktree_path(&item.path)?,
                        object_id: item.object_id,
                        author_name: item.author_name,
                        author_time: item.author_time,
                        commit_time: item.commit_time,
                        subject: item.subject,
                    })
                })
                .collect::<Result<Vec<_>, RpcError>>()?,
            next_cursor: page
                .next_cursor
                .map(|cursor| serde_json::to_string(&cursor))
                .transpose()
                .map_err(|_| RpcError::new(-32061, AppServerErrorName::GitOperationFailed))?,
        })
    }

    pub(super) fn git_catalog(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitRepositoryParams = decode(value)?;
        let catalog = self
            .context
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
            upstream_read_only: catalog.upstream_read_only,
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
            .context
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
            .context
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
            .context
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
            .map_err(|_| git_error(GitRuntimeError::Service(GitServiceError::Runtime)))?;
        let path = runtime
            .block_on(
                crate::git_service::current_client()
                    .clone_repository_reference(&params.url, parent, params.reference.as_deref())
                    .with_cancellation(cancellation.clone()),
            )
            .map_err(|_| git_error(GitRuntimeError::Service(GitServiceError::Cancelled)))?
            .map_err(|error| git_error(GitRuntimeError::Service(GitServiceError::Git(error))))?;
        result(&GitCloneResult {
            repository_path: path.to_string_lossy().into_owned(),
        })
    }

    pub(super) fn git_clone_to(
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
        let params: GitCloneToParams = decode(value)?;
        if params.target_path.len() > 32768 {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| git_error(GitRuntimeError::Service(GitServiceError::Runtime)))?;
        let path = runtime
            .block_on(
                crate::git_service::current_client()
                    .clone_repository_to(
                        &params.url,
                        Path::new(&params.target_path),
                        params.reference.as_deref(),
                    )
                    .with_cancellation(cancellation.clone()),
            )
            .map_err(|_| git_error(GitRuntimeError::Service(GitServiceError::Cancelled)))?
            .map_err(|error| git_error(GitRuntimeError::Service(GitServiceError::Git(error))))?;
        result(&GitCloneResult {
            repository_path: path.to_string_lossy().into_owned(),
        })
    }

    pub(super) fn git_clone_cancel(
        &self,
        connection: &ConnectionState,
        value: &Value,
    ) -> Result<Value, RpcError> {
        if !connection.allows_product_host_capabilities() {
            return Err(RpcError::new(
                -32073,
                AppServerErrorName::PermissionRequired,
            ));
        }
        let params: GitCloneCancelParams = decode(value)?;
        if params.operation_id.is_empty() || params.operation_id.chars().count() > 128 {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        self.request_cancellations
            .cancel_operation(connection.connection_id, params.operation_id);
        self.request_scheduler.cancel_waiting_requests();
        result(&GitCloneCancelResult {})
    }

    pub(super) fn git_repository_contexts(
        &self,
        value: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::git::GitRepositoryContextsParams;
        use ash_app_server_protocol::protocol::git::GitRepositoryContextsResult;
        use ash_file_access::Permission;
        let params: GitRepositoryContextsParams = decode(value)?;
        if !params.session_directory.path.is_absolute() {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let authorization = self.context.session_dir_authorization(
            &params.session_directory.session_id,
            &params.session_directory.path,
            Permission::InspectRepository,
        )?;
        let repositories = super::git_runtime::repository_contexts(&authorization, cancellation)
            .map_err(git_error)?;
        // Do not publish a context whose Session grant retired during the Git I/O.
        authorization
            .ensure_active()
            .map_err(|_| RpcError::new(-32043, AppServerErrorName::PermissionRequired))?;
        result(&GitRepositoryContextsResult { repositories })
    }
    pub(super) fn git_repositories(
        &self,
        connection: &ConnectionState,
        value: &Value,
    ) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::git::GitDiscoveryParams = decode(value)?;
        let folders = params
            .folders
            .map(|folders| {
                folders
                    .into_iter()
                    .map(|folder| {
                        if !(-1..=64).contains(&folder.max_depth)
                            || folder.ignored_folders.len() > 256
                            || folder.scan_repositories.len() > 256
                            || folder.submodule_limit > 1024
                            || folder.worktree_limit > 1024
                            || folder
                                .scan_repositories
                                .iter()
                                .any(|path| path.len() > 32768 || path.contains('\0'))
                            || folder
                                .ignored_folders
                                .iter()
                                .any(|name| name.len() > 1024 || name.contains(['/', '\\', '\0']))
                        {
                            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
                        }
                        Ok(super::git_runtime::GitDiscoveryOptions {
                            dir_id: folder.dir_id,
                            max_depth: folder.max_depth,
                            ignored_folders: folder.ignored_folders,
                            scan_repositories: folder.scan_repositories,
                            detect_submodules: folder.detect_submodules,
                            submodule_limit: folder.submodule_limit,
                            detect_worktrees: folder.detect_worktrees,
                            worktree_limit: folder.worktree_limit,
                        })
                    })
                    .collect::<Result<Vec<_>, RpcError>>()
            })
            .transpose()?;
        let runtime = self.context.git_runtime_service()?;
        let mut discovered = runtime
            .discover_for(connection.connection_id, folders)
            .map_err(git_error)?;
        // Watched state uses the canonical Git policy. Alternate executables and
        // rename thresholds still require their existing authoritative query.
        if params.include_status == Some(true)
            && params.client.as_ref().is_none_or(|client| {
                client.paths.is_empty()
                    && client
                        .similarity_threshold
                        .is_none_or(|threshold| threshold == 50)
            })
        {
            discovered.statuses = Some(
                runtime
                    .published_statuses_for(&discovered.repositories)
                    .map_err(git_error)?,
            );
        }
        result(&discovered)
    }

    pub(super) fn git_status(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitRepositoryParams = decode(value)?;
        let runtime = self.context.git_runtime_service()?;
        let view = params
            .client
            .as_ref()
            .and_then(|client| client.similarity_threshold)
            .is_some_and(|threshold| threshold != 50);
        result(
            &if view {
                runtime.status_view_for(params.repository_id.as_deref())
            } else {
                runtime.status_for(params.repository_id.as_deref())
            }
            .map_err(git_error)?,
        )
    }

    pub(super) fn git_text_diff(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitTextDiffParams = decode(value)?;
        let runtime = self.context.git_runtime_service()?;
        result(
            &match params.projection {
                Some(GitTextDiffProjectionDto::Statistics) => {
                    runtime.text_diff_summary_for(params.repository_id.as_deref())
                }
                None | Some(GitTextDiffProjectionDto::Contents) => {
                    runtime.text_diff_for(params.repository_id.as_deref())
                }
            }
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
            .context
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
            .context
            .git_runtime_service()?
            .local_branches_for(params.repository_id.as_deref())
            .map_err(git_error)?;
        result(&GitBranchListResult { branches })
    }

    pub(super) fn git_history(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitRepositoryParams = decode(value)?;
        let commits = self
            .context
            .git_runtime_service()?
            .recent_commits_for(params.repository_id.as_deref())
            .map_err(git_error)?;
        result(&GitHistoryResult { commits })
    }

    pub(super) fn git_history_refs(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitRepositoryParams = decode(value)?;
        result(
            &self
                .context
                .git_runtime_service()?
                .history_refs_for(params.repository_id.as_deref())
                .map_err(git_error)?,
        )
    }

    pub(super) fn git_graph(&self, connection_id: u64, value: &Value) -> Result<Value, RpcError> {
        let params: GitGraphParams = decode(value)?;
        if params.limit == 0 || params.limit > MAX_GIT_GRAPH_PAGE_SIZE {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        if let Some(revisions) = &params.revisions {
            if revisions.len() > 1000 {
                return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
            }
            for revision in revisions {
                validate_object_id(revision)?;
            }
        }
        let limit = NonZeroUsize::new(params.limit).expect("validated graph page size");
        result(
            &self
                .context
                .git_runtime_service()?
                .graph_for(
                    params.repository_id.as_deref(),
                    connection_id,
                    limit,
                    params.cursor.as_deref(),
                    params.revisions.as_deref(),
                )
                .map_err(git_error)?,
        )
    }

    pub(super) fn git_commit_changes(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitCommitChangesParams = decode(value)?;
        validate_object_id(&params.object_id)?;
        result(
            &self
                .context
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
                .context
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
            .context
            .git_runtime_service()?
            .commit_message_for(params.repository_id.as_deref(), &params.object_id)
            .map_err(git_error)?;
        result(&GitCommitMessageResult { message })
    }

    pub(super) fn git_commit_details(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitCommitChangesParams = decode(value)?;
        validate_object_id(&params.object_id)?;
        let details = self
            .context
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
                .context
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
                .context
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
                .context
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
            .context
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
            .context
            .git_runtime_service()?
            .switch_branch_for(
                params.repository_id.as_deref(),
                &params.name,
                if params.pull_before_checkout == Some(true) {
                    ash_git::GitCheckoutPolicy::FastForward
                } else {
                    ash_git::GitCheckoutPolicy::Keep
                },
            )
            .map_err(git_error)?;
        result(&GitOperationResult { status })
    }

    pub(super) fn git_branch_create(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitBranchCreateParams = decode(value)?;
        if params.name.trim().is_empty() || params.name.len() > 1024 || params.name.contains('\0') {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let branches = self
            .context
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
            .context
            .git_runtime_service()?
            .delete_branch_for(params.repository_id.as_deref(), &params.name)
            .map_err(git_error)?;
        result(&GitBranchListResult { branches })
    }

    pub(super) fn git_worktree_create(&self, value: &Value) -> Result<Value, RpcError> {
        let params: GitWorktreeCreateParams = decode(value)?;
        if let HookEventDecision::Deny { reason } =
            self.context.emit_hook_event(&HookEventRequest {
                event: HookEvent::WorktreeCreate,
                scope: HookEventScope::User,
                subject: Some(params.name.clone()),
                tool_name: None,
            })?
        {
            return Err(core_error(core_api::CoreError::Policy(reason)));
        }
        let source = self
            .context
            .git_runtime_service()?
            .mutable_source_for(params.repository_id.as_deref())
            .map_err(git_error)?;
        let dirs = &self
            .dir_services
            .as_ref()
            .ok_or_else(|| RpcError::new(-32060, AppServerErrorName::GitUnavailable))?;
        let path = dirs
            .runtime
            .block_on(dirs.worktrees.create_unbound_with_options(
                &source,
                &params.name,
                &worktree::WorktreePopulationOptions {
                    include_files: params.include_files,
                    symlink_folders: params.symlink_folders,
                },
            ))
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
        if let HookEventDecision::Deny { reason } =
            self.context.emit_hook_event(&HookEventRequest {
                event: HookEvent::WorktreeRemove,
                scope: HookEventScope::User,
                subject: Some(params.checkout_root.clone()),
                tool_name: None,
            })?
        {
            return Err(core_error(core_api::CoreError::Policy(reason)));
        }
        let source = self
            .context
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
                self.context
                    .delete_worktree_session(&thread_id, &params.command_id)?;
            }
        }
        result(&self.git_worktree_list_result(params.repository_id.as_deref())?)
    }

    fn git_worktree_list_result(
        &self,
        repository_id: Option<&str>,
    ) -> Result<GitWorktreeListResult, RpcError> {
        let source = self
            .context
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
            .context
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
            .context
            .git_runtime_service()?
            .stage_for(params.repository_id.as_deref(), paths(params.paths)?)
            .map_err(git_error)?;
        result(&GitOperationResult { status })
    }

    pub(super) fn git_unstage(&self, params: &Value) -> Result<Value, RpcError> {
        let params: GitPathsParams = decode(params)?;
        let status = self
            .context
            .git_runtime_service()?
            .unstage_for(params.repository_id.as_deref(), paths(params.paths)?)
            .map_err(git_error)?;
        result(&GitOperationResult { status })
    }

    pub(super) fn git_discard_worktree(&self, params: &Value) -> Result<Value, RpcError> {
        let params: GitPathsParams = decode(params)?;
        let status = self
            .context
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
        let request = match params.signing.unwrap_or(GitCommitSigningDto::Configured) {
            GitCommitSigningDto::Configured => request,
            GitCommitSigningDto::Required => request.require_signing(),
        };
        let request = match params.empty.unwrap_or(GitEmptyCommitPolicyDto::Reject) {
            GitEmptyCommitPolicyDto::Reject => request,
            GitEmptyCommitPolicyDto::Allow => request.allow_empty(),
        };
        let request = match params.hooks {
            Some(ash_app_server_protocol::protocol::git::GitCommitHooksDto::Run) => {
                request.run_hooks()
            }
            Some(ash_app_server_protocol::protocol::git::GitCommitHooksDto::Skip) | None => request,
        };
        let request = match params.identity {
            Some(ash_app_server_protocol::protocol::git::GitCommitIdentityDto::Configured) => {
                request.require_configured_identity()
            }
            Some(ash_app_server_protocol::protocol::git::GitCommitIdentityDto::Inferred) | None => {
                request
            }
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
            .context
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
        let runtime = self.context.git_runtime_service()?;
        let mode = params.mode.unwrap_or(GitFetchModeDto::All);
        let status = if let Some(options) = params.transport {
            use crate::git_service::GitRemoteMutation;
            let operation = match &mode {
                GitFetchModeDto::Default => GitRemoteMutation::FetchDefault,
                GitFetchModeDto::All => GitRemoteMutation::Fetch,
                GitFetchModeDto::Remote(name) => GitRemoteMutation::FetchRemote(name),
            };
            runtime.transport_for(
                params.repository_id.as_deref(),
                operation,
                transport_options(options),
                cancellation,
            )
        } else {
            runtime.fetch_for(params.repository_id.as_deref(), mode, cancellation)
        }
        .map_err(git_error)?;
        result(&GitOperationResult { status })
    }

    pub(super) fn git_pull(
        &self,
        value: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: GitPullParams = decode(value)?;
        let mode = self.resolve_pull_mode(params.mode.unwrap_or_default())?;
        let runtime = self.context.git_runtime_service()?;
        let status = if let Some(options) = params.transport {
            runtime.transport_for(
                params.repository_id.as_deref(),
                crate::git_service::GitRemoteMutation::Pull(mode),
                transport_options(options),
                cancellation,
            )
        } else {
            runtime.pull_for(params.repository_id.as_deref(), mode, cancellation)
        }
        .map_err(git_error)?;
        result(&GitOperationResult { status })
    }

    pub(super) fn git_push(
        &self,
        value: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: GitRepositoryParams = decode(value)?;
        let runtime = self.context.git_runtime_service()?;
        let status = if let Some(options) = params.transport {
            runtime.transport_for(
                params.repository_id.as_deref(),
                crate::git_service::GitRemoteMutation::Push,
                transport_options(options),
                cancellation,
            )
        } else {
            runtime.push_for(params.repository_id.as_deref(), cancellation)
        }
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
        GitRuntimeError::Service(GitServiceError::Git(
            error @ GitError::UnsupportedVersion { .. },
        )) => RpcError::with_details(
            -32061,
            AppServerErrorName::GitOperationFailed,
            error.to_string(),
        ),
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
        GitCommandDto::PublishBranch {
            remote,
            name,
            branch,
            expected_head,
        } => ash_git::GitCommand::PublishBranch {
            remote,
            name,
            branch,
            expected_head,
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

fn transport_options(
    value: ash_app_server_protocol::protocol::git::GitTransportOptionsDto,
) -> ash_git::GitTransportOptions {
    use ash_app_server_protocol::protocol::git::GitPushModeDto;
    ash_git::GitTransportOptions {
        prune: value.prune,
        tag_policy: if value.pull_tags {
            ash_git::GitTagPolicy::Include
        } else {
            ash_git::GitTagPolicy::Configured
        },
        replace_tags: value.replace_tags,
        auto_stash: value.auto_stash,
        follow_tags: value.follow_tags,
        push_mode: match value.push_mode {
            GitPushModeDto::Normal => ash_git::GitPushMode::Normal,
            GitPushModeDto::Force => ash_git::GitPushMode::Force,
            GitPushModeDto::Lease => ash_git::GitPushMode::Lease,
            GitPushModeDto::LeaseIfIncludes => ash_git::GitPushMode::LeaseIfIncludes,
        },
    }
}

pub(super) fn request_client(value: &Value) -> Result<Option<ash_git::GitClient>, RpcError> {
    let Some(value) = value.get("client").filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let options: ash_app_server_protocol::protocol::git::GitClientOptionsDto = decode(value)?;
    if options.paths.len() > 16
        || options
            .paths
            .iter()
            .any(|path| path.len() > 32768 || path.contains('\0') || !Path::new(path).is_absolute())
    {
        return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
    }
    let client = if options.paths.is_empty() {
        ash_git::GitClient::system()
    } else {
        let path = options
            .paths
            .iter()
            .find(|path| Path::new(path).is_file())
            .unwrap_or(&options.paths[0]);
        ash_git::GitClient::with_executable(
            PathBuf::from(path),
            ash_git::GitExecutionLimits::default(),
        )
        .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?
    };
    let client = if let Some(interaction) = options.interaction {
        let address = interaction
            .address
            .parse()
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let current = std::env::current_exe()
            .map_err(|_| RpcError::new(-32603, AppServerErrorName::InternalError))?;
        let helper = current
            .parent()
            .ok_or_else(|| RpcError::new(-32603, AppServerErrorName::InternalError))?
            .join(format!("ash-git-extension{}", std::env::consts::EXE_SUFFIX));
        client
            .with_askpass(ash_git::GitAskPass {
                program: helper,
                address,
                token: interaction.token,
                scope: interaction.scope,
            })
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?
    } else {
        client
    };
    Ok(Some(
        client
            .with_similarity_threshold(options.similarity_threshold.unwrap_or(50))
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?,
    ))
}

impl<C: GitRequestProcessorContext + ?Sized> GitRequestProcessor<'_, C> {
    pub(super) fn git_init(
        &self,
        value: &serde_json::Value,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<serde_json::Value, RpcError> {
        let params: ash_app_server_protocol::protocol::git::GitInitParams = super::decode(value)?;
        let _gate = self
            .env_runtime_gate
            .lock()
            .map_err(|_| RpcError::new(-32000, AppServerErrorName::ServerOverloaded))?;
        let authorization = {
            let runtime = self
                .env_runtime
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let grant = match params.dir_id.as_deref() {
                Some(id) => runtime.dirs.get(id).map(|dir| &dir.grant),
                None => runtime.selected_grant.as_ref(),
            }
            .ok_or_else(|| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
            let authorization = grant
                .authorize(ash_file_access::Permission::MutateRepository)
                .map_err(|_| RpcError::new(-32043, AppServerErrorName::PermissionRequired))?;
            authorization
        };
        authorization
            .ensure_active()
            .map_err(|_| RpcError::new(-32043, AppServerErrorName::PermissionRequired))?;
        let git = self.context.git_runtime_service()?;
        git.initialize(
            authorization.dir().canonical_path(),
            &params.initial_branch,
            cancellation,
        )
        .map_err(super::git_operations::git_error)?;
        git.reconcile().map_err(super::git_operations::git_error)?;
        super::result(&git.repositories())
    }
}
