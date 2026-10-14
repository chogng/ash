//! Shared directory-grant RPC adaptation for persisted configuration and runtime environments.
//! Validation belongs here at the RPC boundary; typed grants remain owned by file-access.

use super::RpcError;
use ash_app_server_protocol::protocol::environment::PermissionDto;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use std::path::Path;

/// The persisted profile uses absolute paths; session mutations also accept relative paths.
pub(super) enum DirectoryPathRequirement {
    Absolute,
    NonEmpty,
}

pub(super) fn validate_path(
    path: &Path,
    requirement: DirectoryPathRequirement,
) -> Result<(), RpcError> {
    let valid = match requirement {
        DirectoryPathRequirement::Absolute => path.is_absolute(),
        DirectoryPathRequirement::NonEmpty => !path.as_os_str().is_empty(),
    };
    if !valid {
        return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
    }
    Ok(())
}

pub(super) fn permissions(values: Vec<PermissionDto>) -> Result<Permissions, RpcError> {
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

pub(super) fn permission_dtos(value: &Permissions) -> Vec<PermissionDto> {
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
