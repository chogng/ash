use ash_app_server_protocol::protocol::common::EmptyParams;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::marketplace::MarketplaceAcquireCapabilityParams;
use ash_app_server_protocol::protocol::marketplace::MarketplaceDownloadParams;
use ash_app_server_protocol::protocol::marketplace::MarketplaceGetParams;
use ash_app_server_protocol::protocol::marketplace::MarketplaceInstallParams;
use ash_app_server_protocol::protocol::marketplace::MarketplaceListInstalledResult;
use ash_app_server_protocol::protocol::marketplace::MarketplaceOpenResourceParams;
use ash_app_server_protocol::protocol::marketplace::MarketplaceReleaseCapabilityParams;
use ash_app_server_protocol::protocol::marketplace::MarketplaceSearchParams;
use ash_app_server_protocol::protocol::marketplace::MarketplaceUninstallModeDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceUninstallParams;
use ash_app_server_protocol::protocol::marketplace::MarketplaceUpdateParams;
use ash_core_plugins::AcquireCapabilityRequest;
use ash_core_plugins::CapabilityRef;
use ash_core_plugins::DownloadPackageRequest;
use ash_core_plugins::GetPackageRequest;
use ash_core_plugins::InstallPackageRequest;
use ash_core_plugins::ListInstalledRequest;
use ash_core_plugins::MarketplaceClientError;
use ash_core_plugins::MarketplaceClientErrorKind;
use ash_core_plugins::MarketplaceErrorCode;
use ash_core_plugins::OpenResourceRequest;
use ash_core_plugins::ReleaseCapabilityRequest;
use ash_core_plugins::ResourceRef;
use ash_core_plugins::SearchPackagesRequest;
use ash_core_plugins::UninstallMode;
use ash_core_plugins::UninstallPackageRequest;
use ash_core_plugins::UpdatePackageRequest;
use ash_extensions::ExtensionCatalogReload;
use ash_skills_extension::SkillCatalogReload;
use serde_json::Value;

use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::marketplace_projection;
use super::result;

impl AppServer {
    pub(super) fn marketplace_search(&self, params: &Value) -> Result<Value, RpcError> {
        let params: MarketplaceSearchParams = decode(params)?;
        let found = self
            .plugin_packages()?
            .search(SearchPackagesRequest {
                query: params.query,
                package_type: params.package_type,
                capability_kind: params
                    .capability_kind
                    .map(marketplace_projection::domain_capability_kind),
                language_id: params.language_id,
                limit: params.limit.map(|limit| limit as usize),
            })
            .map_err(marketplace_error)?;
        result(&marketplace_projection::search_result(found))
    }

    pub(super) fn marketplace_get(&self, params: &Value) -> Result<Value, RpcError> {
        let params: MarketplaceGetParams = decode(params)?;
        let details = self
            .plugin_packages()?
            .get(GetPackageRequest {
                package_id: params.package_id,
                version: params.version,
            })
            .map_err(marketplace_error)?;
        result(&marketplace_projection::package_details(details))
    }

    pub(super) fn marketplace_download(&self, params: &Value) -> Result<Value, RpcError> {
        let params: MarketplaceDownloadParams = decode(params)?;
        let artifact = self
            .plugin_packages()?
            .download(DownloadPackageRequest {
                package_id: params.package_id,
                version: params.version,
            })
            .map_err(marketplace_error)?;
        result(&marketplace_projection::artifact_handle(artifact))
    }

    pub(super) fn marketplace_install(&self, params: &Value) -> Result<Value, RpcError> {
        let params: MarketplaceInstallParams = decode(params)?;
        let _change = self.updates.lock_marketplace_change();
        let installed = self
            .plugin_packages()?
            .install(InstallPackageRequest {
                package_id: params.package_id,
                version: params.version,
            })
            .map_err(marketplace_error)?;
        self.reconcile_marketplace_consumers();
        self.publish_committed_marketplace_change();
        result(&marketplace_projection::installed_package(installed))
    }

    pub(super) fn marketplace_update(&self, params: &Value) -> Result<Value, RpcError> {
        let params: MarketplaceUpdateParams = decode(params)?;
        let _change = self.updates.lock_marketplace_change();
        let installed = self
            .plugin_packages()?
            .update(UpdatePackageRequest {
                installation_id: params.installation_id,
                version: params.version,
            })
            .map_err(marketplace_error)?;
        self.reconcile_marketplace_consumers();
        self.publish_committed_marketplace_change();
        result(&marketplace_projection::installed_package(installed))
    }

    pub(super) fn marketplace_uninstall(&self, params: &Value) -> Result<Value, RpcError> {
        let params: MarketplaceUninstallParams = decode(params)?;
        let _change = self.updates.lock_marketplace_change();
        self.plugin_packages()?
            .uninstall(UninstallPackageRequest {
                installation_id: params.installation_id,
                mode: match params.mode {
                    MarketplaceUninstallModeDto::IfUnused => UninstallMode::IfUnused,
                    MarketplaceUninstallModeDto::WhenUnused => UninstallMode::WhenUnused,
                },
            })
            .map_err(marketplace_error)?;
        self.reconcile_marketplace_consumers();
        self.publish_committed_marketplace_change();
        result(&())
    }

    pub(super) fn marketplace_list_installed(&self, params: &Value) -> Result<Value, RpcError> {
        let _: EmptyParams = decode(params)?;
        let packages = self
            .plugin_packages()?
            .list_installed(ListInstalledRequest {})
            .map_err(marketplace_error)?
            .into_iter()
            .map(marketplace_projection::installed_package)
            .collect();
        result(&MarketplaceListInstalledResult {
            instance_id: self.updates.marketplace_instance_id().to_owned(),
            generation: self.updates.marketplace_generation(),
            packages,
        })
    }

    pub(super) fn marketplace_acquire_capability(
        &self,
        connection: &mut ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: MarketplaceAcquireCapabilityParams = decode(params)?;
        let acquired = self
            .plugin_packages()?
            .acquire_capability(AcquireCapabilityRequest {
                capability: CapabilityRef {
                    id: params.capability.id,
                },
            })
            .map_err(marketplace_error)?;
        connection.add_marketplace_lease(acquired.lease.id.clone());
        result(&marketplace_projection::acquired_capability(acquired))
    }

    pub(super) fn marketplace_release_capability(
        &self,
        connection: &mut ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: MarketplaceReleaseCapabilityParams = decode(params)?;
        require_owned_lease(connection, &params.lease_id)?;
        let _change = self.updates.lock_marketplace_change();
        let outcome = self
            .plugin_packages()?
            .release_capability(ReleaseCapabilityRequest {
                lease_id: params.lease_id.clone(),
            })
            .map_err(marketplace_error)?;
        connection.remove_marketplace_lease(&params.lease_id);
        self.reconcile_released_marketplace_capability(outcome.installation_changed);
        result(&())
    }

    pub(super) fn marketplace_open_resource(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: MarketplaceOpenResourceParams = decode(params)?;
        require_owned_lease(connection, &params.lease_id)?;
        let content = self
            .plugin_packages()?
            .open_resource(OpenResourceRequest {
                lease_id: params.lease_id,
                resource: ResourceRef {
                    id: params.resource.id,
                },
            })
            .map_err(marketplace_error)?;
        result(&marketplace_projection::resource_content(content))
    }

    fn plugin_packages(&self) -> Result<&dyn ash_core_plugins::PluginPackageService, RpcError> {
        self.plugin_package_service
            .as_deref()
            .ok_or_else(|| RpcError::new(-32100, AppServerErrorName::MarketplaceUnavailable))
    }

    pub(super) fn reconcile_released_marketplace_capability(&self, installation_changed: bool) {
        if installation_changed {
            self.reconcile_marketplace_consumers();
            self.publish_committed_marketplace_change();
        }
    }

    fn publish_committed_marketplace_change(&self) {
        if let Some(manager) = &self.plugins_manager {
            match manager.generation() {
                Ok(generation) => {
                    self.updates.publish_marketplace_manager_changed(
                        manager.change_source_id(),
                        generation,
                    );
                }
                Err(error) => {
                    log::error!("failed to read committed Marketplace generation: {error}");
                }
            }
        } else {
            self.updates.publish_marketplace_changed();
        }
    }

    fn reconcile_marketplace_consumers(&self) {
        if let Some(skills) = &self.skills
            && let Err(error) = skills.list(SkillCatalogReload::Refresh)
        {
            log::error!("failed to reconcile Marketplace Skills: {error}");
        }
        if let Ok(mut extensions) = self.extensions.lock() {
            extensions.list(ExtensionCatalogReload::Refresh);
        }
        if let Some(runtime) = &self.marketplace_language_runtime {
            match runtime.providers() {
                Ok(providers) => {
                    if let Ok(mut language) = self.language.lock() {
                        language.set_server_providers(providers);
                    }
                }
                Err(error) => {
                    log::error!("failed to reconcile Marketplace language servers: {error}");
                }
            }
        }
    }
}

fn require_owned_lease(connection: &ConnectionState, lease_id: &str) -> Result<(), RpcError> {
    if connection.owns_marketplace_lease(lease_id) {
        Ok(())
    } else {
        Err(RpcError::new(
            -32101,
            AppServerErrorName::MarketplaceNotFound,
        ))
    }
}

fn marketplace_error(error: MarketplaceClientError) -> RpcError {
    let name = match error.kind() {
        MarketplaceClientErrorKind::Unavailable => AppServerErrorName::MarketplaceUnavailable,
        MarketplaceClientErrorKind::Protocol => AppServerErrorName::MarketplaceOperationFailed,
        MarketplaceClientErrorKind::Remote(code) => match code {
            MarketplaceErrorCode::PackageNotFound
            | MarketplaceErrorCode::VersionNotFound
            | MarketplaceErrorCode::CapabilityNotFound
            | MarketplaceErrorCode::LeaseNotFound
            | MarketplaceErrorCode::ResourceNotFound
            | MarketplaceErrorCode::InstallationNotFound => AppServerErrorName::MarketplaceNotFound,
            MarketplaceErrorCode::PackageUntrusted => AppServerErrorName::MarketplaceUntrusted,
            MarketplaceErrorCode::PackageIncompatible
            | MarketplaceErrorCode::CapabilityUnsupported => {
                AppServerErrorName::MarketplaceIncompatible
            }
            MarketplaceErrorCode::InstallationInUse => {
                AppServerErrorName::MarketplaceInstallationInUse
            }
            MarketplaceErrorCode::StorageUnavailable | MarketplaceErrorCode::ServiceUnavailable => {
                AppServerErrorName::MarketplaceUnavailable
            }
            MarketplaceErrorCode::InvalidRequest | MarketplaceErrorCode::MethodNotFound => {
                AppServerErrorName::MarketplaceOperationFailed
            }
        },
    };
    RpcError::new(-32101, name)
}
