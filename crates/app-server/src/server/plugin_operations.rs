use super::AppServer;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::plugins::PluginCommandDispositionDto;
use ash_app_server_protocol::protocol::plugins::PluginCommandResultDto;
use ash_app_server_protocol::protocol::plugins::PluginDirectoryAccessDto;
use ash_app_server_protocol::protocol::plugins::PluginInstallLocalParams;
use ash_app_server_protocol::protocol::plugins::PluginInstallLocalResult;
use ash_app_server_protocol::protocol::plugins::PluginListResult;
use ash_app_server_protocol::protocol::plugins::PluginPackageCommandParams;
use ash_app_server_protocol::protocol::plugins::PluginPackageDto;
use ash_app_server_protocol::protocol::plugins::PluginPermissionDto;
use ash_core_plugins::PluginAuthorityCommand;
use ash_core_plugins::PluginAuthorityCommandId;
use ash_core_plugins::PluginAuthorityCommandRequest;
use ash_core_plugins::PluginAuthorityCommandResult;
use ash_core_plugins::PluginAuthorityDisposition;
use ash_plugin::InstalledPluginRef;
use ash_plugin::LocalPluginPackage;
use ash_plugin::PluginError;
use ash_plugin::PluginErrorKind;
use ash_plugin::PluginPackageDigest;
use ash_plugin::PluginPackageId;
use ash_plugin::PluginVersion;
use serde_json::Value;
use std::path::Component;
use std::path::Path;

impl AppServer {
    pub(super) fn plugin_list(&self) -> Result<Value, RpcError> {
        let snapshot = self.plugin_authority()?.snapshot();
        let packages = snapshot
            .installed()
            .iter()
            .map(|package| {
                let manifest = self
                    .plugin_authority()?
                    .installed_manifest(package)
                    .map_err(plugin_error)?;
                Ok(PluginPackageDto {
                    id: package.id.as_str().to_owned(),
                    version: package.version.to_string(),
                    digest: package.digest.as_str().to_owned(),
                    display_name: manifest.display_name,
                    permissions: manifest.permissions.into_iter().map(permission).collect(),
                    has_editor_extensions: !manifest.contributions.editor_extensions.is_empty()
                        || !manifest.contributions.declarative_extensions.is_empty(),
                    enabled: snapshot.enabled().contains(package),
                    granted: snapshot.granted().contains(package),
                    revoked: snapshot.revoked().contains(package),
                    effective: snapshot.activation().packages().iter().any(|active| {
                        active.manifest().id == package.id
                            && active.manifest().version == package.version
                            && active.package_digest() == &package.digest
                    }),
                })
            })
            .collect::<Result<Vec<_>, RpcError>>()?;
        result(&PluginListResult {
            revision: snapshot.revision(),
            activation_generation: snapshot.activation().generation(),
            packages,
        })
    }

    pub(super) fn plugin_install_local(&self, params: &Value) -> Result<Value, RpcError> {
        let params: PluginInstallLocalParams = decode(params)?;
        let path = Path::new(&params.path);
        if params.path.is_empty()
            || path
                .components()
                .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
        {
            return Err(invalid_params());
        }
        let command_id = PluginAuthorityCommandId::new(params.command_id).map_err(plugin_error)?;
        let authorization = {
            let runtime = self.env_runtime.read().expect("environment runtime mutex");
            let grant = match params.dir_id.as_deref() {
                Some(id) => runtime.dirs.get(id),
                None => runtime.selected_grant.as_ref(),
            }
            .ok_or_else(invalid_params)?;
            grant
                .authorize(ash_file_access::Permission::ReadFiles)
                .map_err(|_| RpcError::new(-32043, AppServerErrorName::PermissionRequired))?
        };
        // The package copy runs under the same live directory authorization as its initial scan.
        // The package store validates the bytes again before publishing their immutable digest.
        let installed = authorization
            .execute(
                authorization.subject(),
                authorization.dir(),
                ash_file_access::Permission::ReadFiles,
                || {
                    let root = authorization
                        .dir()
                        .resolve_existing(path)
                        .map_err(|_| invalid_params())?;
                    let package = LocalPluginPackage::load(root).map_err(plugin_error)?;
                    self.plugin_authority()?
                        .install_local(command_id, params.expected_revision, &package)
                        .map_err(plugin_error)
                },
            )
            .map_err(|_| RpcError::new(-32043, AppServerErrorName::PermissionRequired))??;
        result(&PluginInstallLocalResult {
            id: installed.package.id.as_str().to_owned(),
            version: installed.package.version.to_string(),
            digest: installed.package.digest.as_str().to_owned(),
            command: plugin_command_result(installed.command),
        })
    }

    pub(super) fn plugin_enable(&self, params: &Value) -> Result<Value, RpcError> {
        self.plugin_package_command(params, |package| PluginAuthorityCommand::Enable { package })
    }

    pub(super) fn plugin_disable(&self, params: &Value) -> Result<Value, RpcError> {
        self.plugin_package_command(params, |package| PluginAuthorityCommand::Disable {
            package,
        })
    }

    pub(super) fn plugin_grant(&self, params: &Value) -> Result<Value, RpcError> {
        self.plugin_package_command(params, |package| PluginAuthorityCommand::Grant { package })
    }

    pub(super) fn plugin_revoke_grant(&self, params: &Value) -> Result<Value, RpcError> {
        self.plugin_package_command(params, |package| PluginAuthorityCommand::RevokeGrant {
            package,
        })
    }

    pub(super) fn plugin_uninstall(&self, params: &Value) -> Result<Value, RpcError> {
        self.plugin_package_command(params, |package| PluginAuthorityCommand::Uninstall {
            package,
        })
    }

    fn plugin_package_command(
        &self,
        params: &Value,
        command: impl FnOnce(InstalledPluginRef) -> PluginAuthorityCommand,
    ) -> Result<Value, RpcError> {
        let params: PluginPackageCommandParams = decode(params)?;
        let package = package_ref(params.id, params.version, params.digest)?;
        let outcome = self
            .plugin_authority()?
            .apply(PluginAuthorityCommandRequest {
                command_id: PluginAuthorityCommandId::new(params.command_id)
                    .map_err(plugin_error)?,
                expected_revision: params.expected_revision,
                command: command(package),
            })
            .map_err(plugin_error)?;
        result(&plugin_command_result(outcome))
    }

    fn plugin_authority(&self) -> Result<&ash_core_plugins::PluginActivationAuthority, RpcError> {
        self.plugins
            .as_ref()
            .ok_or_else(|| RpcError::new(-32040, AppServerErrorName::PluginsUnavailable))
    }
}

fn permission(value: ash_plugin::Permission) -> PluginPermissionDto {
    match value {
        ash_plugin::Permission::Directory { access } => PluginPermissionDto::Directory {
            access: match access {
                ash_plugin::DirectoryAccess::Read => PluginDirectoryAccessDto::Read,
                ash_plugin::DirectoryAccess::Write => PluginDirectoryAccessDto::Write,
            },
        },
        ash_plugin::Permission::Process { executable } => PluginPermissionDto::Process {
            executable: executable.as_str().to_owned(),
        },
        ash_plugin::Permission::Network { hosts } => PluginPermissionDto::Network {
            hosts: hosts
                .into_iter()
                .map(|host| host.as_str().to_owned())
                .collect(),
        },
    }
}

fn package_ref(
    id: String,
    version: String,
    digest: String,
) -> Result<InstalledPluginRef, RpcError> {
    Ok(InstalledPluginRef {
        id: PluginPackageId::new(id).map_err(|_| invalid_params())?,
        version: PluginVersion::new(version).map_err(|_| invalid_params())?,
        digest: PluginPackageDigest::new(digest).map_err(|_| invalid_params())?,
    })
}

fn plugin_command_result(result: PluginAuthorityCommandResult) -> PluginCommandResultDto {
    PluginCommandResultDto {
        revision: result.revision,
        activation_generation: result.activation_generation,
        disposition: match result.disposition {
            PluginAuthorityDisposition::Updated => PluginCommandDispositionDto::Updated,
            PluginAuthorityDisposition::Replayed => PluginCommandDispositionDto::Replayed,
        },
    }
}

fn plugin_error(error: PluginError) -> RpcError {
    match error.kind() {
        PluginErrorKind::GenerationConflict => {
            RpcError::new(-32041, AppServerErrorName::PluginRevisionConflict)
        }
        PluginErrorKind::CommandConflict => {
            RpcError::new(-32004, AppServerErrorName::CommandConflict)
        }
        PluginErrorKind::SourceUnavailable
        | PluginErrorKind::PackageUnsafe
        | PluginErrorKind::ManifestInvalid
        | PluginErrorKind::ContributionInvalid
        | PluginErrorKind::PackageConflict
        | PluginErrorKind::AuthorityUnavailable
        | PluginErrorKind::PackageInUse
        | PluginErrorKind::PackageRevoked => {
            RpcError::new(-32042, AppServerErrorName::PluginOperationFailed)
        }
    }
}

fn invalid_params() -> RpcError {
    RpcError::new(-32602, AppServerErrorName::InvalidParams)
}

#[cfg(test)]
#[path = "plugin_operations_tests.rs"]
mod tests;
