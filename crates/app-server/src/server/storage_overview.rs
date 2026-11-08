use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::core_error;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::storage::StorageOverview;
use ash_app_server_protocol::protocol::storage::StorageWorktree;
use ash_app_server_protocol::protocol::storage::StorageWorktreeCleanupParams;
use ash_async_utils::CancellationToken;
use ash_file_access::Dir;
use ash_protocol::HookEvent;
use ash_protocol::SessionExecutionTarget;
use ash_protocol::SessionStatus;
use ash_protocol::ThreadStatus;
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use worktree::ManagedDirOwner;
use worktree::WorktreeManager;

impl AppServer {
    pub(super) fn storage_overview(
        &self,
        connection: &ConnectionState,
        cancellation: &CancellationToken,
    ) -> Result<serde_json::Value, RpcError> {
        if !connection.allows_local_media() {
            return Err(RpcError::new(
                -32073,
                AppServerErrorName::PermissionRequired,
            ));
        }
        let state = self.env_state.runtime().ok_or_else(storage_unavailable)?;
        let config = self.config.as_ref().ok_or_else(storage_unavailable)?;
        let desktop = config
            .read_snapshot()
            .map_err(storage_error)?
            .values
            .desktop;
        let worktrees =
            worktree::WorktreeSettings::from_desktop_config(state.profile_root(), &desktop)
                .map_err(storage_error)?;
        let manager = WorktreeManager::new(worktrees);
        let sessions = self.threads.list_sessions().map_err(core_error)?;
        let mut candidates = Vec::new();
        for session in sessions {
            check_cancelled(cancellation)?;
            if session.status != SessionStatus::Archived {
                continue;
            }
            let Some(SessionExecutionTarget::Local { root }) = session.execution_target else {
                continue;
            };
            let Ok(source) = Dir::open_local(root) else {
                continue;
            };
            let switched = manager.for_session_directory(source.id().as_str());
            for thread in session.threads {
                if thread.status != ThreadStatus::Archived {
                    continue;
                }
                let owner = ManagedDirOwner::Thread {
                    thread_id: thread.thread_id.to_string(),
                };
                let Some(checkout) = switched
                    .existing_git_checkout(&owner)
                    .or_else(|| manager.existing_git_checkout(&owner))
                else {
                    continue;
                };
                let record = self
                    .threads
                    .thread_catalog_record(&thread.thread_id)
                    .map_err(core_error)?;
                candidates.push(StorageWorktree {
                    title: thread.title,
                    identity: StorageWorktreeCleanupParams {
                        session_id: session.session_id.clone(),
                        thread_id: thread.thread_id,
                        expected_sequence: record.sequence,
                        checkout_root: checkout.to_string_lossy().into_owned(),
                    },
                    size_bytes: None,
                });
            }
        }
        let mut overview = measure(
            state.profile_root(),
            state.database_path(),
            &manager.settings().root,
            candidates,
            cancellation,
        )?;
        overview.worktrees.sort_by(|left, right| {
            right
                .size_bytes
                .cmp(&left.size_bytes)
                .then_with(|| left.title.cmp(&right.title))
        });
        result(&overview)
    }

    pub(super) fn storage_worktree_cleanup(
        &self,
        connection: &ConnectionState,
        params: StorageWorktreeCleanupParams,
    ) -> Result<serde_json::Value, RpcError> {
        if !connection.allows_local_media() {
            return Err(RpcError::new(
                -32073,
                AppServerErrorName::PermissionRequired,
            ));
        }
        let checkout = Path::new(&params.checkout_root);
        if !checkout.is_absolute()
            || params.checkout_root.len() > 32_768
            || params.checkout_root.contains('\0')
        {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let session = self
            .threads
            .read_session_catalog(&params.session_id)
            .map_err(core_error)?;
        let record = self
            .threads
            .thread_catalog_record(&params.thread_id)
            .map_err(core_error)?;
        if !session.is_some_and(|session| session.status == SessionStatus::Archived)
            || record.session_id != params.session_id
            || record.thread.status != ThreadStatus::Archived
            || record.sequence != params.expected_sequence
        {
            return Err(core_error(core_api::CoreError::CommandConflict));
        }
        let runtime = self
            .git_turn_changes
            .as_ref()
            .ok_or_else(storage_unavailable)?;
        runtime
            .require_session_publications_settled(&params.session_id)
            .map_err(storage_error)?;
        if let core_api::HookEventDecision::Deny { reason } =
            self.emit_hook_event(&core_api::HookEventRequest {
                event: HookEvent::WorktreeRemove,
                scope: core_api::HookEventScope::User,
                subject: Some(params.checkout_root.clone()),
                tool_name: None,
            })?
        {
            return Err(core_error(core_api::CoreError::Policy(reason)));
        }
        runtime
            .cleanup_archived_worktree(&params.thread_id, checkout)
            .map_err(storage_error)?;
        result(&())
    }
}

fn measure(
    profile: &Path,
    database: &Path,
    worktrees: &Path,
    mut candidates: Vec<StorageWorktree>,
    cancellation: &CancellationToken,
) -> Result<StorageOverview, RpcError> {
    let profile = dunce::canonicalize(profile).map_err(storage_error)?;
    let database_name = database.file_name().unwrap_or_default().to_string_lossy();
    let session_entries = [
        database_name.to_string(),
        format!("{database_name}-wal"),
        format!("{database_name}-shm"),
        "attachments".to_owned(),
    ];
    let mut overview = StorageOverview {
        profile_root: profile.to_string_lossy().into_owned(),
        worktree_root: worktrees.to_string_lossy().into_owned(),
        worktree_bytes: 0,
        session_bytes: 0,
        other_bytes: 0,
        complete: true,
        worktrees: Vec::new(),
    };
    let worktrees = match dunce::canonicalize(worktrees) {
        Ok(root) if !profile.starts_with(&root) => Some(root),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        _ => {
            overview.complete = false;
            None
        }
    };
    if let Some(root) = &worktrees {
        overview.worktree_root = root.to_string_lossy().into_owned();
        let mut measured = HashSet::new();
        candidates
            .retain(|candidate| Path::new(&candidate.identity.checkout_root).starts_with(root));
        for candidate in &mut candidates {
            let checkout = PathBuf::from(&candidate.identity.checkout_root);
            if !measured.insert(checkout.clone()) {
                continue;
            }
            let mut complete = true;
            let bytes = directory_bytes(&checkout, &HashSet::new(), cancellation, &mut complete)?;
            overview.worktree_bytes += bytes;
            overview.complete &= complete;
            candidate.size_bytes = complete.then_some(bytes);
        }
        overview.worktree_bytes +=
            directory_bytes(root, &measured, cancellation, &mut overview.complete)?;
        overview.worktrees = candidates;
    }

    let excluded = worktrees.into_iter().collect::<HashSet<_>>();
    let entries = fs::read_dir(&profile).map_err(storage_error)?;
    for entry in entries {
        let Ok(entry) = entry else {
            overview.complete = false;
            continue;
        };
        let path = entry.path();
        let bytes = directory_bytes(&path, &excluded, cancellation, &mut overview.complete)?;
        if session_entries
            .iter()
            .any(|name| entry.file_name() == name.as_str())
        {
            overview.session_bytes += bytes;
        } else {
            overview.other_bytes += bytes;
        }
    }
    Ok(overview)
}

fn directory_bytes(
    root: &Path,
    excluded: &HashSet<PathBuf>,
    cancellation: &CancellationToken,
    complete: &mut bool,
) -> Result<u64, RpcError> {
    let mut paths = vec![root.to_path_buf()];
    let mut bytes = 0_u64;
    while let Some(path) = paths.pop() {
        check_cancelled(cancellation)?;
        if excluded.contains(&path) {
            continue;
        }
        match fs::symlink_metadata(&path) {
            Ok(metadata) if is_link(&metadata) => {}
            Ok(metadata) if metadata.is_file() => bytes += metadata.len(),
            Ok(metadata) if metadata.is_dir() => match fs::read_dir(path) {
                Ok(entries) => {
                    for entry in entries {
                        check_cancelled(cancellation)?;
                        match entry {
                            Ok(entry) => paths.push(entry.path()),
                            Err(_) => *complete = false,
                        }
                    }
                }
                Err(_) => *complete = false,
            },
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => *complete = false,
        }
    }
    Ok(bytes)
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), RpcError> {
    if cancellation.is_cancelled() {
        return Err(RpcError::new(-32800, AppServerErrorName::RequestCancelled));
    }
    Ok(())
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions and other reparse points may cross the measured roots.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    metadata.is_symlink()
}

fn storage_unavailable() -> RpcError {
    storage_error("local profile unavailable")
}

fn storage_error(error: impl std::fmt::Display) -> RpcError {
    core_error(core_api::CoreError::Execution(error.to_string()))
}
