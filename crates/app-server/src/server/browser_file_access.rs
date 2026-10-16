use super::environment_runtime::EnvRuntime;
use ash_async_utils::CancellationToken;
use ash_file_access::Authorization;
use ash_file_access::Permission;
use ash_file_system::LocalFileSystem;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use base64::Engine;
use core_api::BrowserError;
use std::path::Path;
use std::sync::RwLock;

const MAX_UPLOAD_BYTES: usize = 4 * 1024 * 1024;

/// Materializes uploads through the same revocable directory proofs used by file tools.
/// Built-in sensitive-path denials accompany the final read; hard-link checks use its snapshot.
/// The returned bytes cannot cause the browser host to reopen a different local path.
pub(super) fn read(
    runtime: &RwLock<EnvRuntime>,
    config: &RwLock<super::environment_runtime::EnvRuntimeConfig>,
    threads: &ash_core::ThreadController,
    thread: &ThreadId,
    turn: &TurnId,
    paths: &[String],
    cancellation: &CancellationToken,
) -> Result<Vec<ash_app_server_protocol::protocol::browser::BrowserUploadFile>, BrowserError> {
    let denied = || BrowserError::Failed("BrowserFileAccessDenied".into());
    if paths.len() > 16 {
        return Err(denied());
    }
    let policy = config
        .read()
        .map_err(|_| denied())?
        .tools
        .file_access_policy()
        .map_err(|_| denied())?
        .intersect(&crate::local_tools::LOCAL_FILE_ACCESS_POLICY);
    let snapshot = threads.read_thread(thread).map_err(|_| denied())?;
    if matches!(
        snapshot.execution_target,
        Some(
            ash_protocol::SessionExecutionTarget::Ssh { .. }
                | ash_protocol::SessionExecutionTarget::Provider { .. }
        )
    ) {
        return Err(denied());
    }
    if !snapshot
        .turns
        .iter()
        .any(|entry| &entry.turn_id == turn && entry.status == ash_protocol::TurnStatus::Running)
    {
        return Err(denied());
    }
    let runtime = runtime.read().map_err(|_| denied())?;
    let mut authorizations: Vec<Authorization> = runtime
        .dir_grants
        .thread_scope(thread, Permission::ReadFiles)
        .map_err(|_| denied())?
        .into_iter()
        .flat_map(|scope| scope.authorizations().cloned().collect::<Vec<_>>())
        .collect();
    authorizations.extend(
        runtime
            .selected_grant
            .iter()
            .chain(runtime.dirs.values())
            .filter_map(|grant| grant.authorize(Permission::ReadFiles).ok()),
    );
    if let Some(scope) = runtime
        .dir_grants
        .snapshot_for(&snapshot.session_id, Permission::ReadFiles)
        .map_err(|_| denied())?
    {
        authorizations.extend(scope.authorizations().iter().cloned());
    }
    authorizations.extend(runtime.dir_grants.requested_authorizations(
        &snapshot.session_id,
        thread,
        turn,
        Permission::ReadFiles,
    ));
    if let Some(primary) = &runtime.selected_grant {
        authorizations = authorizations
            .into_iter()
            .map(|authorization| authorization.constrained_by(primary.path_policy()))
            .collect();
    }
    drop(runtime);
    authorizations = authorizations
        .into_iter()
        .map(|authorization| authorization.constrained_by(&policy))
        .collect();
    let mut remaining = MAX_UPLOAD_BYTES;
    let mut files = Vec::new();
    let mut used = Vec::new();
    for value in paths {
        cancellation.check().map_err(|_| denied())?;
        let path = Path::new(value);
        if value.len() > 4096
            || value.contains('\0')
            || !path.is_absolute()
            || path
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err(denied());
        }
        let (authorization, relative) = authorizations
            .iter()
            .filter_map(|authorization| {
                path.strip_prefix(authorization.dir().canonical_path())
                    .or_else(|_| path.strip_prefix(authorization.dir().requested_path()))
                    .ok()
                    .map(|relative| (authorization, relative))
            })
            .max_by_key(|(authorization, _)| {
                authorization.dir().canonical_path().components().count()
            })
            .ok_or_else(denied)?;
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| name.len() <= 255)
            .ok_or_else(denied)?;
        #[cfg(test)]
        tests::before_read_snapshot();
        let snapshot = LocalFileSystem::from_authorization(authorization.clone())
            .read_file_snapshot(relative, remaining)
            .map_err(|_| denied())?;
        // A path denial cannot identify hard-link aliases; inspect the object that supplied bytes.
        if snapshot.has_multiple_links() {
            return Err(denied());
        }
        let bytes = &snapshot.content().bytes;
        cancellation.check().map_err(|_| denied())?;
        // A revoked grant cannot publish bytes from an operation admitted before revocation.
        authorization.ensure_active().map_err(|_| denied())?;
        used.push(authorization);
        remaining -= bytes.len();
        files.push(
            ash_app_server_protocol::protocol::browser::BrowserUploadFile {
                name: name.into(),
                data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            },
        );
    }
    cancellation.check().map_err(|_| denied())?;
    for authorization in used {
        authorization.ensure_active().map_err(|_| denied())?;
    }
    Ok(files)
}

#[cfg(test)]
#[path = "browser_file_access_tests.rs"]
mod tests;
