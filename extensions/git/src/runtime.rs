use crate::configuration::GitFetchMode;
use crate::configuration::GitFetchPolicy;
use crate::configuration::ProviderConfiguration;
use crate::git_runtime::GitRuntime;
use crate::git_runtime::GitRuntimeError;
use crate::git_runtime::GitWatcher;
use crate::git_service::GitServiceError;
use crate::updates::GitUpdates;
use ash_app_server_protocol::git_provider::*;
use ash_async_utils::CancellationSource;
use ash_async_utils::FutureCancellationExt;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_git::GitClient;
use ash_git::GitError;
use external_ext_sdk::Extension;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

#[derive(Default)]
struct State {
    runtime: Option<Arc<GitRuntime>>,
    watcher: Option<GitWatcher>,
}

/// Directory-scoped Git provider using the shared SDK's fenced typed channel.
#[derive(Default)]
pub struct GitExtension {
    state: Arc<Mutex<State>>,
    updates: Arc<GitUpdates>,
    configuration: Arc<ProviderConfiguration>,
}

impl Extension for GitExtension {
    fn id(&self) -> &str {
        GIT_PROVIDER_ID
    }
    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError> {
        let state = self.state.clone();
        let updates = self.updates.clone();
        let configuration = self.configuration.clone();
        context.data_channels.register(
            GIT_PROVIDER_CHANNEL,
            move |request: GitProviderRequest, token| {
                token.check_cancelled()?;
                let source = CancellationSource::new();
                let finished = AtomicBool::new(false);
                let response = std::thread::scope(|scope| {
                    let finished = &finished;
                    let source = &source;
                    scope.spawn(move || {
                        while !finished.load(Ordering::Acquire) {
                            if token.is_cancellation_requested() {
                                source.cancel();
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(10));
                        }
                    });
                    let response = crate::git_service::with_invocation(source.token(), || {
                        dispatch(request, &state, &updates, &configuration, &source.token())
                    });
                    let response = if source.token().is_cancelled() {
                        Err(GitRuntimeError::Service(GitServiceError::Cancelled))
                    } else {
                        response
                    };
                    finished.store(true, Ordering::Release);
                    response.map_err(provider_error)
                });
                Ok(response)
            },
        )
    }
    fn deactivate(&mut self) -> Result<(), ExtensionError> {
        let mut state = self.state.lock().expect("Git provider state");
        state.watcher.take();
        state.runtime.take();
        Ok(())
    }
}

fn dispatch(
    request: GitProviderRequest,
    state: &Mutex<State>,
    updates: &Arc<GitUpdates>,
    configuration: &Arc<ProviderConfiguration>,
    cancellation: &ash_async_utils::CancellationToken,
) -> Result<GitProviderResponse, GitRuntimeError> {
    if let GitProviderRequest::Bind {
        version,
        directories,
    } = request
    {
        if version != GIT_PROVIDER_VERSION || directories.len() > 128 {
            return Err(GitRuntimeError::Boundary);
        }
        let mut state = state.lock().map_err(|_| unavailable())?;
        if state.runtime.is_some() {
            return Err(GitRuntimeError::Boundary);
        }
        let mut dirs = Vec::new();
        let mut ids = std::collections::HashSet::new();
        let unscoped = directories.len() == 1 && directories[0].id.is_none();
        for directory in directories {
            if !directory.path.is_absolute() || !ids.insert(directory.id.clone()) {
                return Err(GitRuntimeError::Boundary);
            }
            let permission = if directory.can_mutate {
                Permission::MutateRepository
            } else {
                Permission::InspectRepository
            };
            let authorization = Grant::for_environment(
                Dir::open_local(&directory.path).map_err(|_| GitRuntimeError::Boundary)?,
                GrantSource::HostConfiguration,
                Permissions::new([permission]),
            )
            .authorize(permission)
            .map_err(|_| GitRuntimeError::Boundary)?;
            dirs.push((directory.id, authorization));
        }
        let runtime = if unscoped {
            GitRuntime::new(dirs.pop().expect("one directory").1, updates.clone())?
        } else {
            let dirs = dirs
                .into_iter()
                .map(|(id, authorization)| {
                    let id = id
                        .filter(|id| !id.is_empty() && id.len() <= 256 && !id.contains('\0'))
                        .ok_or(GitRuntimeError::Boundary)?;
                    Ok((id, authorization))
                })
                .collect::<Result<Vec<_>, GitRuntimeError>>()?;
            GitRuntime::new_for_dirs(dirs, updates.clone())?
        };
        state.runtime = Some(runtime);
        return Ok(GitProviderResponse::Done);
    }
    let runtime = state
        .lock()
        .map_err(|_| unavailable())?
        .runtime
        .clone()
        .ok_or_else(unavailable)?;
    match request {
        GitProviderRequest::Bind { .. } => unreachable!(),
        GitProviderRequest::CommonDirectory { repository_id } => runtime
            .common_dir_for(repository_id.as_deref())
            .map(GitProviderResponse::Path),
        GitProviderRequest::Reconcile => {
            runtime.reconcile()?;
            Ok(GitProviderResponse::Done)
        }
        GitProviderRequest::StartWatching { policy } => {
            configuration
                .set(policy_config(policy))
                .map_err(|_| GitRuntimeError::Boundary)?;
            let mut state = state.lock().map_err(|_| unavailable())?;
            if state.watcher.is_none() {
                state.watcher = Some(runtime.start_watching(Some(configuration.clone())));
            }
            Ok(GitProviderResponse::Done)
        }
        GitProviderRequest::Configure { policy } => {
            configuration
                .set(policy_config(policy))
                .map_err(|_| GitRuntimeError::Boundary)?;
            Ok(GitProviderResponse::Done)
        }
        GitProviderRequest::DrainEvents => Ok(GitProviderResponse::Events(updates.drain())),
        GitProviderRequest::Clone { url, parent } => {
            if !parent.is_absolute() {
                return Err(GitRuntimeError::Boundary);
            }
            let executor = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| unavailable())?;
            let path = executor
                .block_on(
                    GitClient::system()
                        .clone_repository(&url, &parent)
                        .with_cancellation(cancellation.clone()),
                )
                .map_err(|_| GitRuntimeError::Service(GitServiceError::Cancelled))?
                .map_err(|error| GitRuntimeError::Service(GitServiceError::Git(error)))?;
            Ok(GitProviderResponse::Path(path))
        }
        GitProviderRequest::Initialize { root, branch } => {
            runtime.initialize(&root, &branch, cancellation)?;
            Ok(GitProviderResponse::Done)
        }
        // Repository requests use the same domain implementation as the former in-process host.
        GitProviderRequest::Repositories => {
            Ok(GitProviderResponse::Repositories(runtime.repositories()))
        }
        GitProviderRequest::Status { repository_id } => runtime
            .status_for(repository_id.as_deref())
            .map(GitProviderResponse::Status),
        GitProviderRequest::CheckIgnore {
            repository_id,
            paths,
        } => runtime
            .check_ignore_for(repository_id.as_deref(), &paths, &cancellation)
            .map(GitProviderResponse::Paths),
        GitProviderRequest::LocalBranches { repository_id } => runtime
            .local_branches_for(repository_id.as_deref())
            .map(GitProviderResponse::Branches),
        GitProviderRequest::Catalog { repository_id } => runtime
            .catalog_for(repository_id.as_deref())
            .map(GitProviderResponse::Catalog),
        GitProviderRequest::Command {
            repository_id,
            command,
        } => runtime
            .command_for(repository_id.as_deref(), &command, &cancellation)
            .map(GitProviderResponse::Command),
        GitProviderRequest::IndexDiff {
            repository_id,
            path,
            comparison,
        } => {
            let value = runtime.index_diff_for(repository_id.as_deref(), &path, comparison)?;
            Ok(GitProviderResponse::IndexDiff {
                original: value.original,
                modified: value.modified,
            })
        }
        GitProviderRequest::IndexEdit {
            repository_id,
            request,
        } => runtime
            .index_edit_for(repository_id.as_deref(), &request)
            .map(GitProviderResponse::Status),
        GitProviderRequest::CreateBranch {
            repository_id,
            name,
        } => runtime
            .create_branch_for(repository_id.as_deref(), &name)
            .map(GitProviderResponse::Branches),
        GitProviderRequest::DeleteBranch {
            repository_id,
            name,
        } => runtime
            .delete_branch_for(repository_id.as_deref(), &name)
            .map(GitProviderResponse::Branches),
        GitProviderRequest::MutableSource { repository_id } => runtime
            .mutable_source_for(repository_id.as_deref())
            .map(GitProviderResponse::Path),
        GitProviderRequest::ReadableSource { repository_id } => runtime
            .readable_source_for(repository_id.as_deref())
            .map(GitProviderResponse::Path),
        GitProviderRequest::RecentCommits { repository_id } => runtime
            .recent_commits_for(repository_id.as_deref())
            .map(GitProviderResponse::History),
        GitProviderRequest::HistoryRefs { repository_id } => runtime
            .history_refs_for(repository_id.as_deref())
            .map(GitProviderResponse::HistoryRefs),
        GitProviderRequest::Graph {
            repository_id,
            connection_id,
            limit,
            cursor,
            revisions,
        } => runtime
            .graph_for(
                repository_id.as_deref(),
                connection_id,
                limit,
                cursor.as_deref(),
                revisions.as_deref(),
            )
            .map(GitProviderResponse::Graph),
        GitProviderRequest::TextDiff { repository_id } => runtime
            .text_diff_for(repository_id.as_deref())
            .map(GitProviderResponse::TextDiff),
        GitProviderRequest::CommitChanges {
            repository_id,
            object_id,
        } => runtime
            .commit_changes_for(repository_id.as_deref(), &object_id)
            .map(GitProviderResponse::CommitChanges),
        GitProviderRequest::CompareChanges {
            repository_id,
            object_id,
            base_reference,
            mode,
        } => runtime
            .compare_changes_for(repository_id.as_deref(), &object_id, &base_reference, mode)
            .map(GitProviderResponse::CompareChanges),
        GitProviderRequest::CommitMessage {
            repository_id,
            object_id,
        } => runtime
            .commit_message_for(repository_id.as_deref(), &object_id)
            .map(GitProviderResponse::Text),
        GitProviderRequest::CommitDetails {
            repository_id,
            object_id,
        } => runtime
            .commit_details_for(repository_id.as_deref(), &object_id)
            .map(GitProviderResponse::CommitDetails),
        GitProviderRequest::CommitFile {
            repository_id,
            object_id,
            path,
            comparison_base,
        } => runtime
            .commit_file_for(
                repository_id.as_deref(),
                &object_id,
                &path,
                comparison_base.as_deref(),
            )
            .map(GitProviderResponse::CommitFile),
        GitProviderRequest::ChangeFile {
            repository_id,
            path,
            comparison,
        } => runtime
            .change_file_for(repository_id.as_deref(), &path, comparison)
            .map(GitProviderResponse::ChangeFile),
        GitProviderRequest::ConflictFile {
            repository_id,
            path,
        } => runtime
            .conflict_file_for(repository_id.as_deref(), &path)
            .map(GitProviderResponse::ConflictFile),
        GitProviderRequest::CompleteConflict {
            repository_id,
            path,
            expected_stage_ids,
            expected_result_object_id,
            resolution,
        } => runtime
            .complete_conflict_for(
                repository_id.as_deref(),
                &path,
                expected_stage_ids,
                expected_result_object_id,
                resolution,
            )
            .map(GitProviderResponse::Status),
        GitProviderRequest::SwitchBranch {
            repository_id,
            name,
        } => runtime
            .switch_branch_for(repository_id.as_deref(), &name)
            .map(GitProviderResponse::Status),
        GitProviderRequest::Stage {
            repository_id,
            paths,
        } => runtime
            .stage_for(repository_id.as_deref(), paths)
            .map(GitProviderResponse::Status),
        GitProviderRequest::Unstage {
            repository_id,
            paths,
        } => runtime
            .unstage_for(repository_id.as_deref(), paths)
            .map(GitProviderResponse::Status),
        GitProviderRequest::DiscardWorktree {
            repository_id,
            paths,
        } => runtime
            .discard_worktree_for(repository_id.as_deref(), paths)
            .map(GitProviderResponse::Status),
        GitProviderRequest::Commit {
            repository_id,
            request,
        } => {
            let value = runtime.commit_for(repository_id.as_deref(), request)?;
            Ok(GitProviderResponse::Commit {
                object_id: value.object_id,
                status: value.status,
            })
        }
        GitProviderRequest::Fetch {
            repository_id,
            mode,
        } => runtime
            .fetch_for(repository_id.as_deref(), mode, &cancellation)
            .map(GitProviderResponse::Status),
        GitProviderRequest::PullFastForward { repository_id } => runtime
            .pull_fast_forward_for(repository_id.as_deref(), &cancellation)
            .map(GitProviderResponse::Status),
        GitProviderRequest::Push { repository_id } => runtime
            .push_for(repository_id.as_deref(), &cancellation)
            .map(GitProviderResponse::Status),
        GitProviderRequest::CloseConnection { connection_id } => {
            runtime.close_connection(connection_id);
            Ok(GitProviderResponse::Done)
        }
    }
}

fn unavailable() -> GitRuntimeError {
    GitRuntimeError::Service(GitServiceError::Runtime)
}

fn provider_error(error: GitRuntimeError) -> GitProviderError {
    match error {
        GitRuntimeError::Boundary => GitProviderError::Boundary,
        GitRuntimeError::InvalidGraphCursor => GitProviderError::InvalidGraphCursor,
        GitRuntimeError::RepositoryNotFound => GitProviderError::RepositoryNotFound,
        GitRuntimeError::Service(error) => match error {
            GitServiceError::Cancelled => GitProviderError::Cancelled,
            GitServiceError::BranchNotFound => GitProviderError::BranchNotFound,
            GitServiceError::Boundary => GitProviderError::Boundary,
            GitServiceError::CommitChangeNotFound => GitProviderError::CommitChangeNotFound,
            GitServiceError::ConflictChanged => GitProviderError::ConflictChanged,
            GitServiceError::Git(GitError::IndexChanged) => GitProviderError::IndexChanged,
            GitServiceError::Git(GitError::NotAWorkingTree { .. }) => {
                GitProviderError::NotAWorkingTree
            }
            GitServiceError::Git(error) => GitProviderError::OperationFailed {
                detail: error.to_string(),
            },
            GitServiceError::Runtime => GitProviderError::Runtime,
            GitServiceError::Permission => GitProviderError::Unavailable,
        },
    }
}

fn policy_config(policy: GitProviderPolicy) -> GitFetchPolicy {
    GitFetchPolicy {
        autofetch: match policy.autofetch {
            GitProviderFetch::Off => GitFetchMode::Off,
            GitProviderFetch::Default => GitFetchMode::Default,
            GitProviderFetch::All => GitFetchMode::All,
        },
        autofetch_period: policy.autofetch_period,
    }
}
