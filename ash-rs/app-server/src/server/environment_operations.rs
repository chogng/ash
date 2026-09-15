use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::config_operations::config_command_result;
use super::config_operations::config_operation_error;
use super::decode;
use super::environment_runtime::EnvRuntimeError;
use super::result;
use ash_app_server_protocol::protocol::environment::DirContributionsDto;
use ash_app_server_protocol::protocol::environment::DirGrantDto;
use ash_app_server_protocol::protocol::environment::DirPermissionsEntryDto;
use ash_app_server_protocol::protocol::environment::DirPermissionsForgetParams;
use ash_app_server_protocol::protocol::environment::DirPermissionsListResult;
use ash_app_server_protocol::protocol::environment::DirPermissionsReadParams;
use ash_app_server_protocol::protocol::environment::DirPermissionsReadResult;
use ash_app_server_protocol::protocol::environment::DirPermissionsSetParams;
use ash_app_server_protocol::protocol::environment::EnvCwdSetParams;
use ash_app_server_protocol::protocol::environment::EnvCwdSetResult;
use ash_app_server_protocol::protocol::environment::EnvDirDto;
use ash_app_server_protocol::protocol::environment::EnvDirsSetParams;
use ash_app_server_protocol::protocol::environment::EnvDirsSetResult;
use ash_app_server_protocol::protocol::environment::PermissionDto;
use ash_app_server_protocol::protocol::environment::SessionDirAddParams;
use ash_app_server_protocol::protocol::environment::SessionDirAddResult;
use ash_app_server_protocol::protocol::environment::SessionDirDto;
use ash_app_server_protocol::protocol::environment::SessionDirListParams;
use ash_app_server_protocol::protocol::environment::SessionDirListResult;
use ash_app_server_protocol::protocol::environment::SessionDirMutationDto;
use ash_app_server_protocol::protocol::environment::SessionDirMutationResult;
use ash_app_server_protocol::protocol::environment::SessionDirPermissionsSetParams;
use ash_app_server_protocol::protocol::environment::SessionDirRemoveParams;
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

impl AppServer {
    pub(super) fn session_dir_list(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        require_dir_permissions_host(connection)?;
        let params: SessionDirListParams = decode(params)?;
        let snapshot = self
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
        require_dir_permissions_host(connection)?;
        let params: SessionDirAddParams = decode(params)?;
        validate_path(&params.path, false)?;
        let permissions = permissions(params.permissions)?;
        let (path, mutation, snapshot) = self
            .add_session_dir(&params.session_id, params.path, permissions)
            .map_err(environment_runtime_error)?;
        result(&SessionDirAddResult {
            path,
            mutation: session_dir_mutation(mutation),
            revision: snapshot.revision,
            dirs: session_dir_dtos(snapshot.dirs),
        })
    }

    pub(super) fn session_dir_remove(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        require_dir_permissions_host(connection)?;
        let params: SessionDirRemoveParams = decode(params)?;
        validate_path(&params.path, false)?;
        let (mutation, snapshot) = self
            .remove_session_dir(&params.session_id, &params.path)
            .map_err(environment_runtime_error)?;
        result(&SessionDirMutationResult {
            mutation: session_dir_mutation(mutation),
            revision: snapshot.revision,
            dirs: session_dir_dtos(snapshot.dirs),
        })
    }

    pub(super) fn session_dir_permissions_set(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        require_dir_permissions_host(connection)?;
        let params: SessionDirPermissionsSetParams = decode(params)?;
        validate_path(&params.path, false)?;
        let permissions = permissions(params.permissions)?;
        let (mutation, snapshot) = self
            .set_session_dir_permissions(
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

    pub(super) fn dir_permissions_read(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        require_dir_permissions_host(connection)?;
        let params: DirPermissionsReadParams = decode(params)?;
        validate_path(&params.path, true)?;
        let dir = Dir::open_local(params.path)
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let snapshot = self.dir_config_snapshot()?;
        let configured = snapshot
            .values
            .dir_permissions
            .explicit_permissions_for(&dir.id())
            .map(permission_dtos);
        result(&DirPermissionsReadResult {
            dir: dir.id(),
            permissions: configured,
        })
    }

    pub(super) fn dir_permissions_list(
        &self,
        connection: &ConnectionState,
    ) -> Result<Value, RpcError> {
        require_dir_permissions_host(connection)?;
        let snapshot = self.dir_config_snapshot()?;
        let entries = snapshot
            .values
            .dir_permissions
            .entries
            .iter()
            .map(|(dir, permissions)| DirPermissionsEntryDto {
                dir: dir.clone(),
                path: snapshot
                    .values
                    .dir_permissions
                    .path_for(dir)
                    .map(std::path::Path::to_path_buf),
                permissions: permission_dtos(permissions),
            })
            .collect();
        result(&DirPermissionsListResult {
            revision: snapshot.revision.get(),
            entries,
        })
    }

    pub(super) fn dir_permissions_set(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        require_dir_permissions_host(connection)?;
        let params: DirPermissionsSetParams = decode(params)?;
        validate_path(&params.path, true)?;
        let dir = Dir::open_local(params.path)
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let command = UserConfigCommand::SetDirPermissions {
            dir: dir.id(),
            permissions: permissions(params.permissions)?,
            display_path: Some(dir.canonical_path().to_path_buf()),
        };
        let outcome = self
            .dir_config_store()?
            .apply(ConfigCommandRequest {
                command_id: params.command_id,
                expected_revision: ConfigRevision::new(params.expected_revision),
                command,
            })
            .map_err(config_operation_error)?;
        let command_result = config_command_result(outcome);
        self.reconcile_active_dir_permissions()?;
        result(&command_result)
    }

    pub(super) fn dir_permissions_forget(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        require_dir_permissions_host(connection)?;
        let params: DirPermissionsForgetParams = decode(params)?;
        let outcome = self
            .dir_config_store()?
            .apply(ConfigCommandRequest {
                command_id: params.command_id,
                expected_revision: ConfigRevision::new(params.expected_revision),
                command: UserConfigCommand::ForgetDirPermissions { dir: params.dir },
            })
            .map_err(config_operation_error)?;
        let command_result = config_command_result(outcome);
        self.reconcile_active_dir_permissions()?;
        result(&command_result)
    }

    pub(super) fn env_cwd_set(
        &self,
        _connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: EnvCwdSetParams = decode(params)?;
        validate_path(&params.cwd, true)?;
        let cwd = self
            .set_env_cwd(params.cwd)
            .map_err(environment_runtime_error)?;
        result(&EnvCwdSetResult { cwd })
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
            validate_path(&entry.path, true)?;
            let grant = self.resolve_dir_grant(connection, &entry.path, entry.grant)?;
            let grant = self
                .authorize_local_dir_root(entry.path, grant)
                .map_err(environment_runtime_error)?;
            dirs.push((entry.id, grant));
        }
        let dirs = self
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
                require_dir_permissions_host(connection)?;
                Some((GrantSource::HostConfiguration, permissions(values)?))
            }
            DirGrantDto::User {
                command_id,
                expected_revision,
                permissions: values,
            } => {
                require_dir_permissions_host(connection)?;
                let dir = Dir::open_local(path)
                    .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
                let permissions = permissions(values)?;
                self.dir_config_store()?
                    .apply(ConfigCommandRequest {
                        command_id,
                        expected_revision: ConfigRevision::new(expected_revision),
                        command: UserConfigCommand::SetDirPermissions {
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

    fn dir_config_store(&self) -> Result<&ash_config::ConfigStore, RpcError> {
        self.config
            .as_deref()
            .ok_or_else(|| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))
    }

    fn dir_config_snapshot(&self) -> Result<ash_config::ResolvedConfigSnapshot, RpcError> {
        self.dir_config_store()?
            .read_snapshot()
            .map_err(|_| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))
    }

    pub(crate) fn reconcile_active_dir_permissions(&self) -> Result<(), RpcError> {
        if self.local_env_host.is_none() {
            return Ok(());
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
        let snapshot = self.dir_config_snapshot()?;
        let configured = snapshot
            .values
            .dir_permissions
            .explicit_permissions_for(&active.dir().id())
            .cloned();
        if configured.as_ref() == Some(active.permissions()) {
            return Ok(());
        }
        match configured {
            Some(permissions) => self
                .switch_local_dir_root_with_permissions(
                    active.dir().canonical_path().to_path_buf(),
                    GrantSource::ExplicitUser,
                    permissions,
                )
                .map(|_| ())
                .map_err(environment_runtime_error),
            None if active.source() == GrantSource::ExplicitUser => {
                let Some(runtime) = self.env_runtime_control() else {
                    return Ok(());
                };
                runtime
                    .reconcile_user_dir_permissions(&snapshot.values)
                    .map_err(environment_runtime_error)
            }
            None => Ok(()),
        }
    }
}

fn validate_path(path: &std::path::Path, require_absolute: bool) -> Result<(), RpcError> {
    if path.as_os_str().is_empty() || (require_absolute && !path.is_absolute()) {
        return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
    }
    Ok(())
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

fn permissions(values: Vec<PermissionDto>) -> Result<Permissions, RpcError> {
    let permissions = values.into_iter().map(permission).collect::<Vec<_>>();
    let unique = permissions
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    if unique.len() != permissions.len() {
        return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
    }
    Ok(Permissions::new(permissions))
}

fn permission(value: PermissionDto) -> Permission {
    match value {
        PermissionDto::ReadFiles => Permission::ReadFiles,
        PermissionDto::WriteFiles => Permission::WriteFiles,
        PermissionDto::ExecuteCommands => Permission::ExecuteCommands,
        PermissionDto::WatchFiles => Permission::WatchFiles,
        PermissionDto::BrowseFiles => Permission::BrowseFiles,
        PermissionDto::SearchFiles => Permission::SearchFiles,
        PermissionDto::LoadInstructions => Permission::LoadInstructions,
        PermissionDto::LoadConfig => Permission::LoadConfig,
        PermissionDto::DiscoverSkills => Permission::DiscoverSkills,
        PermissionDto::DiscoverMcp => Permission::DiscoverMcp,
        PermissionDto::UseLanguageServices => Permission::UseLanguageServices,
        PermissionDto::DiscoverHooks => Permission::DiscoverHooks,
        PermissionDto::DiscoverPlugins => Permission::DiscoverPlugins,
        PermissionDto::InspectRepository => Permission::InspectRepository,
        PermissionDto::MutateRepository => Permission::MutateRepository,
    }
}

fn permission_dtos(value: &Permissions) -> Vec<PermissionDto> {
    value.entries().map(permission_dto).collect()
}

fn permission_dto(value: Permission) -> PermissionDto {
    match value {
        Permission::ReadFiles => PermissionDto::ReadFiles,
        Permission::WriteFiles => PermissionDto::WriteFiles,
        Permission::ExecuteCommands => PermissionDto::ExecuteCommands,
        Permission::WatchFiles => PermissionDto::WatchFiles,
        Permission::BrowseFiles => PermissionDto::BrowseFiles,
        Permission::SearchFiles => PermissionDto::SearchFiles,
        Permission::LoadInstructions => PermissionDto::LoadInstructions,
        Permission::LoadConfig => PermissionDto::LoadConfig,
        Permission::DiscoverSkills => PermissionDto::DiscoverSkills,
        Permission::DiscoverMcp => PermissionDto::DiscoverMcp,
        Permission::UseLanguageServices => PermissionDto::UseLanguageServices,
        Permission::DiscoverHooks => PermissionDto::DiscoverHooks,
        Permission::DiscoverPlugins => PermissionDto::DiscoverPlugins,
        Permission::InspectRepository => PermissionDto::InspectRepository,
        Permission::MutateRepository => PermissionDto::MutateRepository,
    }
}

fn require_dir_permissions_host(connection: &ConnectionState) -> Result<(), RpcError> {
    if connection.supports_dir_permissions_host() {
        Ok(())
    } else {
        Err(RpcError::new(
            -32073,
            AppServerErrorName::PermissionRequired,
        ))
    }
}

fn environment_runtime_error(error: EnvRuntimeError) -> RpcError {
    match error {
        EnvRuntimeError::Unavailable => {
            RpcError::new(-32070, AppServerErrorName::EnvCwdSetUnavailable)
        }
        EnvRuntimeError::Busy => RpcError::new(-32071, AppServerErrorName::EnvCwdSetBusy),
        EnvRuntimeError::AccessRevisionConflict => {
            RpcError::new(-32074, AppServerErrorName::RevisionConflict)
        }
        EnvRuntimeError::PermissionRequired => {
            RpcError::new(-32073, AppServerErrorName::PermissionRequired)
        }
        EnvRuntimeError::Failed(_) => RpcError::new(-32072, AppServerErrorName::EnvCwdSetFailed),
    }
}
