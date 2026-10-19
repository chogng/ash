use super::ConnectionState;
use super::RpcError;
use super::config_operations::config_operation_error;
use super::decode;
use super::directory_grants_protocol::DirectoryPathRequirement;
use super::directory_grants_protocol::permission_dtos;
use super::directory_grants_protocol::permissions;
use super::directory_grants_protocol::validate_path;
use super::environment_runtime::EnvRuntimeError;
use super::result;
use ash_app_server_protocol::protocol::environment::DirContributionsDto;
use ash_app_server_protocol::protocol::environment::DirGrantDto;
use ash_app_server_protocol::protocol::environment::EnvDirDto;
use ash_app_server_protocol::protocol::environment::EnvDirReadParams;
use ash_app_server_protocol::protocol::environment::EnvDirsSetParams;
use ash_app_server_protocol::protocol::environment::EnvDirsSetResult;
use ash_app_server_protocol::protocol::environment::SessionDirAddParams;
use ash_app_server_protocol::protocol::environment::SessionDirAddResult;
use ash_app_server_protocol::protocol::environment::SessionDirDto;
use ash_app_server_protocol::protocol::environment::SessionDirListParams;
use ash_app_server_protocol::protocol::environment::SessionDirListResult;
use ash_app_server_protocol::protocol::environment::SessionDirMoveParams;
use ash_app_server_protocol::protocol::environment::SessionDirMoveResult;
use ash_app_server_protocol::protocol::environment::SessionDirMutationDto;
use ash_app_server_protocol::protocol::environment::SessionDirMutationResult;
use ash_app_server_protocol::protocol::environment::SessionDirRemoveParams;
use ash_app_server_protocol::protocol::environment::SessionDirectoryGrantSetParams;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_config::ConfigCommandRequest;
use ash_config::ConfigRevision;
use ash_config::UserConfigCommand;
use ash_file_access::Dir;
use ash_file_access::GrantSource;
use ash_file_access::Mutation;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use serde_json::Value;

/// Coordinates the existing owners needed by the environment adapter.
/// This contract deliberately exposes no server object or unrestricted service registry.
pub(super) trait EnvironmentRequestProcessorContext: Send + Sync {
    fn activate_local_dirs(
        &self,
        dirs: Vec<(String, ash_file_access::Grant)>,
    ) -> Result<
        Vec<(String, std::path::PathBuf, ash_file_access::Permissions)>,
        super::environment_runtime::EnvRuntimeError,
    >;
    fn add_session_dir(
        &self,
        session_id: &ash_protocol::SessionId,
        root: std::path::PathBuf,
        permissions: ash_file_access::Permissions,
    ) -> Result<
        (
            std::path::PathBuf,
            ash_file_access::Mutation,
            super::environment_runtime::SessionDirEntrySnapshotSet,
        ),
        super::environment_runtime::EnvRuntimeError,
    >;
    fn authorize_local_dir_root(
        &self,
        root: std::path::PathBuf,
        grant: Option<(ash_file_access::GrantSource, ash_file_access::Permissions)>,
    ) -> Result<ash_file_access::Grant, super::environment_runtime::EnvRuntimeError>;
    fn directory_grants_snapshot(
        &self,
    ) -> Result<ash_config::ResolvedConfigSnapshot, super::RpcError>;
    fn directory_grants_store(&self) -> Result<&ash_config::ConfigStore, super::RpcError>;
    fn env_runtime_control(&self) -> Option<super::environment_runtime::EnvRuntimeControl>;
    fn list_session_dirs(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<
        super::environment_runtime::SessionDirEntrySnapshotSet,
        super::environment_runtime::EnvRuntimeError,
    >;
    fn move_session_dir(
        &self,
        session_id: &ash_protocol::SessionId,
        root: std::path::PathBuf,
        permissions: ash_file_access::Permissions,
    ) -> Result<
        (
            std::path::PathBuf,
            super::environment_runtime::SessionDirEntrySnapshotSet,
        ),
        super::environment_runtime::EnvRuntimeError,
    >;
    fn remove_session_dir(
        &self,
        session_id: &ash_protocol::SessionId,
        root: &std::path::Path,
    ) -> Result<
        (
            ash_file_access::Mutation,
            super::environment_runtime::SessionDirEntrySnapshotSet,
        ),
        super::environment_runtime::EnvRuntimeError,
    >;
    fn set_session_directory_grant(
        &self,
        session_id: &ash_protocol::SessionId,
        root: &std::path::Path,
        expected_revision: u64,
        permissions: ash_file_access::Permissions,
    ) -> Result<
        (
            ash_file_access::Mutation,
            super::environment_runtime::SessionDirEntrySnapshotSet,
        ),
        super::environment_runtime::EnvRuntimeError,
    >;
    fn switch_local_dir_root_with_permissions(
        &self,
        root: std::path::PathBuf,
        source: ash_file_access::GrantSource,
        permissions: ash_file_access::Permissions,
    ) -> Result<std::path::PathBuf, super::environment_runtime::EnvRuntimeError>;
}

pub(super) struct EnvironmentRequestProcessor<'ctx, C: EnvironmentRequestProcessorContext + ?Sized>
{
    context: &'ctx C,
    env_runtime: &'ctx super::Arc<super::RwLock<super::EnvRuntime>>,
    local_env_host: &'ctx Option<super::LocalEnvHost>,
}

impl<'ctx, C: EnvironmentRequestProcessorContext + ?Sized> EnvironmentRequestProcessor<'ctx, C> {
    pub(super) fn new(
        context: &'ctx C,
        env_runtime: &'ctx super::Arc<super::RwLock<super::EnvRuntime>>,
        local_env_host: &'ctx Option<super::LocalEnvHost>,
    ) -> Self {
        Self {
            context,
            env_runtime,
            local_env_host,
        }
    }
}

impl<'ctx, C: EnvironmentRequestProcessorContext + ?Sized> EnvironmentRequestProcessor<'ctx, C> {
    pub(super) fn session_dir_list(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        connection.require_directory_grants_host()?;
        let params: SessionDirListParams = decode(params)?;
        let snapshot = self
            .context
            .list_session_dirs(&params.session_id)
            .map_err(environment_runtime_error)?;
        result(&SessionDirListResult {
            revision: snapshot.revision,
            dirs: session_dir_dtos(snapshot.dirs),
        })
    }

    pub(super) fn session_dir_add(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        connection.require_directory_grants_host()?;
        let params: SessionDirAddParams = decode(params)?;
        validate_path(&params.path, DirectoryPathRequirement::NonEmpty)?;
        let permissions = permissions(params.permissions)?;
        let (path, mutation, snapshot) = self
            .context
            .add_session_dir(&params.session_id, params.path, permissions)
            .map_err(environment_runtime_error)?;
        result(&SessionDirAddResult {
            path,
            mutation: session_dir_mutation(mutation),
            revision: snapshot.revision,
            dirs: session_dir_dtos(snapshot.dirs),
        })
    }

    pub(super) fn session_dir_move(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        connection.require_directory_grants_host()?;
        let params: SessionDirMoveParams = decode(params)?;
        validate_path(&params.path, DirectoryPathRequirement::NonEmpty)?;
        let permissions = permissions(params.permissions)?;
        let (cwd, snapshot) = self
            .context
            .move_session_dir(&params.session_id, params.path, permissions)
            .map_err(environment_runtime_error)?;
        result(&SessionDirMoveResult {
            cwd,
            revision: snapshot.revision,
            dirs: session_dir_dtos(snapshot.dirs),
        })
    }

    pub(super) fn session_dir_remove(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        connection.require_directory_grants_host()?;
        let params: SessionDirRemoveParams = decode(params)?;
        validate_path(&params.path, DirectoryPathRequirement::NonEmpty)?;
        let (mutation, snapshot) = self
            .context
            .remove_session_dir(&params.session_id, &params.path)
            .map_err(environment_runtime_error)?;
        result(&SessionDirMutationResult {
            mutation: session_dir_mutation(mutation),
            revision: snapshot.revision,
            dirs: session_dir_dtos(snapshot.dirs),
        })
    }

    pub(super) fn session_directory_grant_set(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        connection.require_directory_grants_host()?;
        let params: SessionDirectoryGrantSetParams = decode(params)?;
        validate_path(&params.path, DirectoryPathRequirement::NonEmpty)?;
        let permissions = permissions(params.permissions)?;
        let (mutation, snapshot) = self
            .context
            .set_session_directory_grant(
                &params.session_id,
                &params.path,
                params.expected_revision,
                permissions,
            )
            .map_err(environment_runtime_error)?;
        result(&SessionDirMutationResult {
            mutation: session_dir_mutation(mutation),
            revision: snapshot.revision,
            dirs: session_dir_dtos(snapshot.dirs),
        })
    }

    pub(super) fn env_dir_read(&self, params: &Value) -> Result<Value, RpcError> {
        let params: EnvDirReadParams = decode(params)?;
        if params.dir_id.trim().is_empty() || params.dir_id.len() > 256 {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let runtime = self
            .env_runtime
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // The environment owner already selected these directories. Never open a
        // client-supplied path or expose the profile's unrelated saved grants.
        let directory = runtime
            .dirs
            .get(&params.dir_id)
            .filter(|directory| directory.grant.is_active())
            .ok_or_else(|| RpcError::new(-32043, AppServerErrorName::PermissionRequired))?;
        result(&EnvDirDto {
            id: params.dir_id,
            path: directory.grant.dir().canonical_path().to_path_buf(),
            permissions: permission_dtos(directory.grant.permissions()),
        })
    }

    pub(super) fn env_dirs_set(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: EnvDirsSetParams = decode(params)?;
        if params.dirs.len() > 256 {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let mut ids = std::collections::BTreeSet::new();
        let mut dirs = Vec::with_capacity(params.dirs.len());
        for entry in params.dirs {
            if entry.id.trim().is_empty() || entry.id.len() > 256 || !ids.insert(entry.id.clone()) {
                return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
            }
            validate_path(&entry.path, DirectoryPathRequirement::Absolute)?;
            let grant = self.resolve_dir_grant(connection, &entry.path, entry.grant)?;
            let grant = self
                .context
                .authorize_local_dir_root(entry.path, grant)
                .map_err(environment_runtime_error)?;
            dirs.push((entry.id, grant));
        }
        let dirs = self
            .context
            .activate_local_dirs(dirs)
            .map_err(environment_runtime_error)?
            .into_iter()
            .map(|(id, path, permissions)| EnvDirDto {
                id,
                path,
                permissions: permission_dtos(&permissions),
            })
            .collect();
        result(&EnvDirsSetResult { dirs })
    }

    fn resolve_dir_grant(
        &self,
        connection: &ConnectionState,
        path: &std::path::Path,
        grant: DirGrantDto,
    ) -> Result<Option<(GrantSource, Permissions)>, RpcError> {
        Ok(match grant {
            DirGrantDto::Config => None,
            DirGrantDto::Host {
                permissions: values,
            } => {
                connection.require_directory_grants_host()?;
                Some((GrantSource::HostConfiguration, permissions(values)?))
            }
            DirGrantDto::User {
                command_id,
                expected_revision,
                permissions: values,
            } => {
                connection.require_directory_grants_host()?;
                let dir = Dir::open_local(path)
                    .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
                let permissions = permissions(values)?;
                self.context
                    .directory_grants_store()?
                    .apply(ConfigCommandRequest {
                        command_id,
                        expected_revision: ConfigRevision::new(expected_revision),
                        command: UserConfigCommand::SetDirectoryGrant {
                            dir: dir.id(),
                            permissions: permissions.clone(),
                            display_path: Some(dir.canonical_path().to_path_buf()),
                        },
                    })
                    .map_err(config_operation_error)?;
                Some((GrantSource::ExplicitUser, permissions))
            }
        })
    }

    pub(crate) fn reconcile_active_directory_grant(&self) -> Result<(), RpcError> {
        if self.local_env_host.is_none() {
            return Ok(());
        }
        let snapshot = self.context.directory_grants_snapshot()?;
        if let Some(runtime) = self.context.env_runtime_control() {
            if runtime.is_web_session() {
                return runtime
                    .reconcile_user_directory_grants(&snapshot.values)
                    .map_err(environment_runtime_error);
            }
            runtime
                .reconcile_user_directory_routes(&snapshot.values)
                .map_err(environment_runtime_error)?;
        }
        let active = self
            .env_runtime
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .selected_grant
            .clone();
        let Some(active) = active else {
            return Ok(());
        };
        let configured = snapshot
            .values
            .directory_grants
            .explicit_permissions_for(&active.dir().id())
            .cloned();
        if configured.as_ref() == Some(active.permissions()) {
            return Ok(());
        }
        match configured {
            Some(permissions) => self
                .context
                .switch_local_dir_root_with_permissions(
                    active.dir().canonical_path().to_path_buf(),
                    GrantSource::ExplicitUser,
                    permissions,
                )
                .map(|_| ())
                .map_err(environment_runtime_error),
            None if active.source() == GrantSource::ExplicitUser => {
                let Some(runtime) = self.context.env_runtime_control() else {
                    return Ok(());
                };
                runtime
                    .reconcile_user_directory_grants(&snapshot.values)
                    .map_err(environment_runtime_error)
            }
            None => Ok(()),
        }
    }
}

fn session_dir_dtos(
    dirs: Vec<super::environment_runtime::SessionDirEntrySnapshot>,
) -> Vec<SessionDirDto> {
    dirs.into_iter()
        .map(|dir| SessionDirDto {
            contributions: dir_contributions(&dir.path, &dir.permissions),
            path: dir.path,
            permissions: permission_dtos(&dir.permissions),
        })
        .collect()
}

fn dir_contributions(path: &std::path::Path, permissions: &Permissions) -> DirContributionsDto {
    let mut result = DirContributionsDto::default();
    if permissions.allows(Permission::DiscoverSkills) {
        if let Ok(entries) = std::fs::read_dir(path.join(".ash/skills")) {
            result
                .skills
                .extend(entries.filter_map(Result::ok).filter_map(|entry| {
                    entry
                        .path()
                        .join("SKILL.md")
                        .is_file()
                        .then(|| entry.file_name().to_string_lossy().into_owned())
                }));
        }
    }
    let needs_config = permissions.allows(Permission::DiscoverMcp)
        || permissions.allows(Permission::DiscoverHooks)
        || permissions.allows(Permission::DiscoverPlugins);
    if !needs_config {
        return result;
    }
    let dir = match Dir::open_local(path) {
        Ok(dir) => dir,
        Err(error) => {
            result.diagnostics.push(error.to_string());
            return result;
        }
    };
    let document = match super::environment_runtime::read_dir_config(&dir) {
        Ok(document) => document,
        Err(error) => {
            result.diagnostics.push(error.to_string());
            return result;
        }
    };
    if permissions.allows(Permission::DiscoverMcp) {
        result
            .mcp_servers
            .extend(document.mcp.servers.keys().map(ToString::to_string));
    }
    if permissions.allows(Permission::DiscoverHooks) {
        result
            .hooks
            .extend(document.hooks.hooks.keys().map(ToString::to_string));
    }
    if permissions.allows(Permission::DiscoverPlugins) {
        result.plugins.extend(
            document
                .plugin_requests
                .requests
                .keys()
                .map(ToString::to_string),
        );
    }
    result.skills.sort();
    result.skills.dedup();
    result.mcp_servers.sort();
    result.hooks.sort();
    result.plugins.sort();
    result
}

fn session_dir_mutation(mutation: Mutation) -> SessionDirMutationDto {
    match mutation {
        Mutation::AddedDir | Mutation::AddedSource => SessionDirMutationDto::Added,
        Mutation::AlreadyPresent => SessionDirMutationDto::AlreadyPresent,
        Mutation::RemovedDir | Mutation::RemovedSource => SessionDirMutationDto::Removed,
        Mutation::UpdatedPermissions => SessionDirMutationDto::Updated,
        Mutation::NotPresent => SessionDirMutationDto::NotPresent,
    }
}

pub(super) fn environment_runtime_error(error: EnvRuntimeError) -> RpcError {
    match error {
        EnvRuntimeError::Unavailable => {
            RpcError::new(-32070, AppServerErrorName::EnvironmentUnavailable)
        }
        EnvRuntimeError::Busy => RpcError::new(-32071, AppServerErrorName::EnvironmentBusy),
        EnvRuntimeError::AccessRevisionConflict => {
            RpcError::new(-32074, AppServerErrorName::RevisionConflict)
        }
        EnvRuntimeError::PermissionRequired => {
            RpcError::new(-32073, AppServerErrorName::PermissionRequired)
        }
        EnvRuntimeError::Failed(_) => RpcError::new(-32072, AppServerErrorName::EnvironmentFailed),
    }
}
