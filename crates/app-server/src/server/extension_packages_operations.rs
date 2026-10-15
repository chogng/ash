use ash_app_server_protocol::protocol::common::EmptyParams;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsAcquireCapabilityParams;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsDownloadParams;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsGetParams;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsInstallParams;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsListInstalledResult;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsOpenResourceParams;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsReleaseCapabilityParams;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsSearchParams;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsUninstallModeDto;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsUninstallParams;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsUpdateParams;
use ash_core_plugins::AcquireCapabilityRequest;
use ash_core_plugins::CapabilityRef;
use ash_core_plugins::DownloadPackageRequest;
use ash_core_plugins::ExtensionPackageService;
use ash_core_plugins::ExtensionsClientError;
use ash_core_plugins::ExtensionsClientErrorKind;
use ash_core_plugins::ExtensionsErrorCode;
use ash_core_plugins::GetPackageRequest;
use ash_core_plugins::InstallPackageRequest;
use ash_core_plugins::ListInstalledRequest;
use ash_core_plugins::OpenResourceRequest;
use ash_core_plugins::ReleaseCapabilityRequest;
use ash_core_plugins::ResourceRef;
use ash_core_plugins::SearchPackagesRequest;
use ash_core_plugins::UninstallMode;
use ash_core_plugins::UninstallPackageRequest;
use ash_core_plugins::UpdatePackageRequest;
use ash_external_ext::packages::ExtensionPackagesReload;
use ash_skills_extension::SkillCatalogReload;
use serde_json::Value;

use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::extension_packages_projection;
use super::result;

impl AppServer {
    pub(super) fn extension_packages_built_in_providers(
        &self,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let _: EmptyParams = decode(params)?;
        result(&self.built_in_providers_snapshot()?)
    }

    pub(super) fn extension_packages_set_built_in_provider_enablement(
        &self,
        params: &Value,
    ) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::extension_packages::ExtensionsBuiltInProviderEnablementParams;
        let params: ExtensionsBuiltInProviderEnablementParams = decode(params)?;
        let _change = self.updates.lock_extension_packages_change();
        let runtime = self
            .built_in_extension_runtimes
            .iter()
            .find(|runtime| runtime.id() == params.id);
        let editor_runtime = self.extension_hosts.as_ref().filter(|runtime| {
            runtime
                .product_extension_states()
                .iter()
                .any(|(id, _)| id == &params.id)
        });
        if runtime.is_none() && editor_runtime.is_none() {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let policy = self
            .editor_extension_policy
            .as_ref()
            .ok_or_else(|| RpcError::new(-32040, AppServerErrorName::PluginsUnavailable))?;
        let action = if params.enabled {
            ash_core_plugins::EditorExtensionPolicyAction::Enable
        } else {
            ash_core_plugins::EditorExtensionPolicyAction::Disable
        };
        policy
            .set_built_in_enablement(&params.id, action, params.expected_revision)
            .map_err(|error| match error {
                ash_core_plugins::EditorExtensionPolicyError::RevisionConflict => {
                    RpcError::new(-32041, AppServerErrorName::PluginRevisionConflict)
                }
                ash_core_plugins::EditorExtensionPolicyError::InvalidBinding => {
                    RpcError::new(-32602, AppServerErrorName::InvalidParams)
                }
                ash_core_plugins::EditorExtensionPolicyError::Storage => {
                    RpcError::new(-32042, AppServerErrorName::PluginOperationFailed)
                }
            })?;
        if let Some(runtime) = runtime {
            runtime
                .reconcile_enablement()
                .map_err(|_| RpcError::new(-32042, AppServerErrorName::PluginOperationFailed))?;
        }
        if let Some(runtime) = editor_runtime {
            runtime
                .reconcile(super::extension_host_runtime::ExtensionHostReconcileMode::Refresh)
                .map_err(|_| RpcError::new(-32042, AppServerErrorName::PluginOperationFailed))?;
        }
        self.updates.publish_extension_packages_changed();
        result(&self.built_in_providers_snapshot()?)
    }

    fn built_in_providers_snapshot(
        &self,
    ) -> Result<
        ash_app_server_protocol::protocol::extension_packages::ExtensionsBuiltInProvidersResult,
        RpcError,
    > {
        use ash_app_server_protocol::protocol::extension_packages::ExtensionsBuiltInProviderDto;
        use ash_app_server_protocol::protocol::extension_packages::ExtensionsBuiltInProvidersResult;
        let policy = self
            .editor_extension_policy
            .as_ref()
            .ok_or_else(|| RpcError::new(-32040, AppServerErrorName::PluginsUnavailable))?;
        Ok(ExtensionsBuiltInProvidersResult {
            revision: policy.generation(),
            providers: self
                .built_in_extension_runtimes
                .iter()
                .map(|runtime| ExtensionsBuiltInProviderDto {
                    id: runtime.id().into(),
                    enabled: policy.is_extension_enabled(runtime.id()),
                    running: runtime.is_running(),
                })
                .chain(
                    self.extension_hosts
                        .iter()
                        .flat_map(|runtime| runtime.product_extension_states())
                        .map(|(id, running)| ExtensionsBuiltInProviderDto {
                            enabled: policy.is_extension_enabled(&id),
                            id,
                            running,
                        }),
                )
                .collect(),
        })
    }

    pub(super) fn extension_packages_editor_extensions(
        &self,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let _: EmptyParams = decode(params)?;
        result(&self.editor_extension_policy_snapshot()?)
    }

    pub(super) fn extension_packages_set_editor_extension_policy(
        &self,
        params: &Value,
    ) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::extension_packages::ExtensionsEditorExtensionPolicyActionDto as Action;
        use ash_app_server_protocol::protocol::extension_packages::ExtensionsEditorExtensionPolicyParams;
        use ash_core_plugins::EditorExtensionPolicyAction as PolicyAction;
        use ash_core_plugins::EditorExtensionPolicyError;
        let params: ExtensionsEditorExtensionPolicyParams = decode(params)?;
        let _change = self.updates.lock_extension_packages_change();
        let policy = self
            .editor_extension_policy
            .as_ref()
            .ok_or_else(|| RpcError::new(-32040, AppServerErrorName::PluginsUnavailable))?;
        let manager = self
            .plugins_manager
            .as_ref()
            .ok_or_else(|| RpcError::new(-32040, AppServerErrorName::PluginsUnavailable))?;
        let installed = manager
            .list_installed(ListInstalledRequest {})
            .map_err(extension_packages_error)?
            .into_iter()
            .find(|package| {
                package.installation_id == params.installation_id
                    && package.package.digest == params.package_digest
            })
            .ok_or_else(|| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let source = self
            .editor_extension_policy_sources()?
            .into_iter()
            .find(|source| *source.package() == installed.package)
            .ok_or_else(|| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        if matches!(params.action, Action::Grant)
            && (source.kind() != ash_core_plugins::CapabilityKind::EditorExtension
                || !ash_external_ext::ProductNodeLauncher::supports_platform()
                || !crate::extension_packages_editor_extensions::javascript_entrypoint(&source)
                    .is_ok_and(|entry| entry.is_some()))
        {
            return Err(extension_packages_error(ExtensionsClientError::business(
                ExtensionsErrorCode::PackageIncompatible,
                "This extension has no admitted JavaScript entry on this platform",
                false,
            )));
        }
        let action = match params.action {
            Action::Enable => PolicyAction::Enable,
            Action::Disable => PolicyAction::Disable,
            Action::Grant => PolicyAction::Grant,
            Action::Revoke => PolicyAction::Revoke,
        };
        policy
            .set(
                source.package(),
                source.capability(),
                action,
                params.expected_revision,
            )
            .map_err(|error| match error {
                EditorExtensionPolicyError::RevisionConflict => {
                    RpcError::new(-32041, AppServerErrorName::PluginRevisionConflict)
                }
                EditorExtensionPolicyError::InvalidBinding => {
                    RpcError::new(-32602, AppServerErrorName::InvalidParams)
                }
                EditorExtensionPolicyError::Storage => {
                    RpcError::new(-32042, AppServerErrorName::PluginOperationFailed)
                }
            })?;
        if let Some(runtime) = &self.extension_hosts {
            runtime
                .reconcile(super::extension_host_runtime::ExtensionHostReconcileMode::Refresh)
                .map_err(|_| RpcError::new(-32042, AppServerErrorName::PluginOperationFailed))?;
        }
        if matches!(
            action,
            ash_core_plugins::EditorExtensionPolicyAction::Enable
                | ash_core_plugins::EditorExtensionPolicyAction::Disable
        ) {
            self.reconcile_extension_packages_consumers();
        }
        self.updates.publish_extension_packages_changed();
        result(&self.editor_extension_policy_snapshot()?)
    }

    fn editor_extension_policy_snapshot(
        &self,
    ) -> Result<
        ash_app_server_protocol::protocol::extension_packages::ExtensionsEditorExtensionsResult,
        RpcError,
    > {
        use ash_app_server_protocol::protocol::extension_packages::ExtensionsEditorExtensionPolicyDto;
        use ash_app_server_protocol::protocol::extension_packages::ExtensionsEditorExtensionsResult;
        let policy = self
            .editor_extension_policy
            .as_ref()
            .ok_or_else(|| RpcError::new(-32040, AppServerErrorName::PluginsUnavailable))?;
        let manager = self
            .plugins_manager
            .as_ref()
            .ok_or_else(|| RpcError::new(-32040, AppServerErrorName::PluginsUnavailable))?;
        let installed = manager
            .list_installed(ListInstalledRequest {})
            .map_err(extension_packages_error)?;
        let sources = self.editor_extension_policy_sources()?;
        let mut extensions = Vec::new();
        for source in sources {
            let Some(package) = installed
                .iter()
                .find(|package| package.package == *source.package())
            else {
                continue;
            };
            if extensions
                .iter()
                .any(|extension: &ExtensionsEditorExtensionPolicyDto| {
                    extension.installation_id == package.installation_id
                })
            {
                continue;
            }
            let state = policy.snapshot(source.package(), source.capability());
            let entrypoint = if source.kind() == ash_core_plugins::CapabilityKind::EditorExtension
                && ash_external_ext::ProductNodeLauncher::supports_platform()
            {
                crate::extension_packages_editor_extensions::javascript_entrypoint(&source)
                    .ok()
                    .flatten()
            } else {
                None
            };
            extensions.push(ExtensionsEditorExtensionPolicyDto {
                installation_id: package.installation_id.clone(),
                package: extension_packages_projection::package_ref(source.package().clone()),
                entrypoint,
                enabled: state.enabled,
                granted: state.granted,
            });
        }
        Ok(ExtensionsEditorExtensionsResult {
            revision: policy.generation(),
            extensions,
        })
    }

    fn editor_extension_policy_sources(
        &self,
    ) -> Result<Vec<ash_core_plugins::LocalCapabilitySource>, RpcError> {
        let manager = self
            .plugins_manager
            .as_ref()
            .ok_or_else(|| RpcError::new(-32040, AppServerErrorName::PluginsUnavailable))?;
        let mut sources = Vec::new();
        // Select executable consent before other editor assets in a multi-capability package.
        for kind in [
            ash_core_plugins::CapabilityKind::EditorExtension,
            ash_core_plugins::CapabilityKind::Language,
            ash_core_plugins::CapabilityKind::Theme,
        ] {
            sources.extend(
                manager
                    .local_capability_sources(kind)
                    .map_err(extension_packages_error)?,
            );
        }
        Ok(sources)
    }

    pub(super) fn extension_packages_search(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ExtensionsSearchParams = decode(params)?;
        let found = self
            .plugin_packages()?
            .search(SearchPackagesRequest {
                query: params.query,
                package_type: params.package_type,
                capability_kind: params
                    .capability_kind
                    .map(extension_packages_projection::domain_capability_kind),
                language_id: params.language_id,
                limit: params.limit.map(|limit| limit as usize),
            })
            .map_err(extension_packages_error)?;
        result(&extension_packages_projection::search_result(found))
    }

    pub(super) fn extension_packages_get(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ExtensionsGetParams = decode(params)?;
        let details = self
            .plugin_packages()?
            .get(GetPackageRequest {
                package_id: params.package_id,
                version: params.version,
            })
            .map_err(extension_packages_error)?;
        result(&extension_packages_projection::package_details(details))
    }

    pub(super) fn extension_packages_search_page(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::extension_packages::ExtensionsSearchPageParams = decode(params)?;
        let found = self
            .plugin_packages()?
            .search_page(ash_core_plugins::SearchPackagesPageRequest {
                source_id: params.source_id,
                cursor: params.cursor,
                search: SearchPackagesRequest {
                    query: params.query,
                    package_type: params.package_type,
                    capability_kind: params
                        .capability_kind
                        .map(extension_packages_projection::domain_capability_kind),
                    language_id: params.language_id,
                    limit: Some(params.page_size as usize),
                },
            })
            .map_err(extension_packages_error)?;
        result(
            &ash_app_server_protocol::protocol::extension_packages::ExtensionsSearchPageResult {
                packages: found
                    .packages
                    .into_iter()
                    .map(extension_packages_projection::package_summary)
                    .collect(),
                total: found.total as u64,
                next_cursor: found.next_cursor,
            },
        )
    }

    pub(super) fn extension_packages_download(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ExtensionsDownloadParams = decode(params)?;
        let artifact = self
            .plugin_packages()?
            .download(DownloadPackageRequest {
                package_id: params.package_id,
                version: params.version,
            })
            .map_err(extension_packages_error)?;
        result(&extension_packages_projection::artifact_handle(artifact))
    }

    pub(super) fn extension_packages_install(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ExtensionsInstallParams = decode(params)?;
        let _change = self.updates.lock_extension_packages_change();
        let installed = self
            .plugin_packages()?
            .install(InstallPackageRequest {
                package_id: params.package_id,
                version: params.version,
            })
            .map_err(extension_packages_error)?;
        self.reconcile_extension_packages_consumers();
        self.publish_committed_extension_packages_change();
        result(&extension_packages_projection::installed_package(installed))
    }

    pub(super) fn extension_packages_update(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ExtensionsUpdateParams = decode(params)?;
        let _change = self.updates.lock_extension_packages_change();
        let installed = self
            .plugin_packages()?
            .update(UpdatePackageRequest {
                installation_id: params.installation_id,
                version: params.version,
            })
            .map_err(extension_packages_error)?;
        self.reconcile_extension_packages_consumers();
        self.publish_committed_extension_packages_change();
        result(&extension_packages_projection::installed_package(installed))
    }

    pub(super) fn extension_packages_uninstall(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ExtensionsUninstallParams = decode(params)?;
        let _change = self.updates.lock_extension_packages_change();
        self.plugin_packages()?
            .uninstall(UninstallPackageRequest {
                installation_id: params.installation_id,
                mode: match params.mode {
                    ExtensionsUninstallModeDto::IfUnused => UninstallMode::IfUnused,
                    ExtensionsUninstallModeDto::WhenUnused => UninstallMode::WhenUnused,
                },
            })
            .map_err(extension_packages_error)?;
        self.reconcile_extension_packages_consumers();
        self.publish_committed_extension_packages_change();
        result(&())
    }

    pub(super) fn extension_packages_list_installed(
        &self,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let _: EmptyParams = decode(params)?;
        let packages = self
            .plugin_packages()?
            .list_installed(ListInstalledRequest {})
            .map_err(extension_packages_error)?
            .into_iter()
            .map(extension_packages_projection::installed_package)
            .collect();
        result(&ExtensionsListInstalledResult {
            instance_id: self.updates.extension_packages_instance_id().to_owned(),
            generation: self.updates.extension_packages_generation(),
            packages,
        })
    }

    pub(super) fn extension_packages_acquire_capability(
        &self,
        connection: &mut ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ExtensionsAcquireCapabilityParams = decode(params)?;
        let acquired = self
            .plugin_packages()?
            .acquire_capability(AcquireCapabilityRequest {
                capability: CapabilityRef {
                    id: params.capability.id,
                },
            })
            .map_err(extension_packages_error)?;
        connection.add_extension_packages_lease(acquired.lease.id.clone());
        result(&extension_packages_projection::acquired_capability(
            acquired,
        ))
    }

    pub(super) fn extension_packages_release_capability(
        &self,
        connection: &mut ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ExtensionsReleaseCapabilityParams = decode(params)?;
        require_owned_lease(connection, &params.lease_id)?;
        let _change = self.updates.lock_extension_packages_change();
        let outcome = self
            .plugin_packages()?
            .release_capability(ReleaseCapabilityRequest {
                lease_id: params.lease_id.clone(),
            })
            .map_err(extension_packages_error)?;
        connection.remove_extension_packages_lease(&params.lease_id);
        self.reconcile_released_extension_packages_capability(outcome.installation_changed);
        result(&())
    }

    pub(super) fn extension_packages_open_resource(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ExtensionsOpenResourceParams = decode(params)?;
        require_owned_lease(connection, &params.lease_id)?;
        let content = self
            .plugin_packages()?
            .open_resource(OpenResourceRequest {
                lease_id: params.lease_id,
                resource: ResourceRef {
                    id: params.resource.id,
                },
            })
            .map_err(extension_packages_error)?;
        result(&extension_packages_projection::resource_content(content))
    }

    fn plugin_packages(&self) -> Result<&dyn ash_core_plugins::ExtensionPackageService, RpcError> {
        self.plugin_package_service
            .as_deref()
            .ok_or_else(|| RpcError::new(-32100, AppServerErrorName::ExtensionsUnavailable))
    }

    pub(super) fn reconcile_released_extension_packages_capability(
        &self,
        installation_changed: bool,
    ) {
        if installation_changed {
            self.reconcile_extension_packages_consumers();
            self.publish_committed_extension_packages_change();
        }
    }

    fn publish_committed_extension_packages_change(&self) {
        if let Some(manager) = &self.plugins_manager {
            match manager.generation() {
                Ok(generation) => {
                    self.updates.publish_extension_packages_manager_changed(
                        manager.change_source_id(),
                        generation,
                    );
                }
                Err(error) => {
                    log::error!("failed to read committed Extensions generation: {error}");
                }
            }
        } else {
            self.updates.publish_extension_packages_changed();
        }
    }

    pub(super) fn reconcile_extension_packages_consumers(&self) {
        if let Some(skills) = &self.skills
            && let Err(error) = skills.list(SkillCatalogReload::Refresh)
        {
            log::error!("failed to reconcile Extensions Skills: {error}");
        }
        if let Ok(mut extensions) = self.extensions.lock() {
            extensions.list(ExtensionPackagesReload::Refresh);
        }
        if let Some(runtime) = &self.extension_packages_language_runtime {
            match runtime.providers() {
                Ok(providers) => {
                    if let Ok(mut language) = self.language.lock() {
                        language.set_server_providers(providers);
                    }
                }
                Err(error) => {
                    log::error!("failed to reconcile Extensions language servers: {error}");
                }
            }
        }
    }
}

fn require_owned_lease(connection: &ConnectionState, lease_id: &str) -> Result<(), RpcError> {
    if connection.owns_extension_packages_lease(lease_id) {
        Ok(())
    } else {
        Err(RpcError::new(
            -32101,
            AppServerErrorName::ExtensionsNotFound,
        ))
    }
}

pub(super) fn extension_packages_error(error: ExtensionsClientError) -> RpcError {
    let name = match error.kind() {
        ExtensionsClientErrorKind::Unavailable => AppServerErrorName::ExtensionsUnavailable,
        ExtensionsClientErrorKind::Protocol => AppServerErrorName::ExtensionsOperationFailed,
        ExtensionsClientErrorKind::Remote(code) => match code {
            ExtensionsErrorCode::PackageNotFound
            | ExtensionsErrorCode::VersionNotFound
            | ExtensionsErrorCode::CapabilityNotFound
            | ExtensionsErrorCode::LeaseNotFound
            | ExtensionsErrorCode::ResourceNotFound
            | ExtensionsErrorCode::InstallationNotFound => AppServerErrorName::ExtensionsNotFound,
            ExtensionsErrorCode::PackageUntrusted => AppServerErrorName::ExtensionsUntrusted,
            ExtensionsErrorCode::PackageIncompatible
            | ExtensionsErrorCode::CapabilityUnsupported => {
                AppServerErrorName::ExtensionsIncompatible
            }
            ExtensionsErrorCode::InstallationInUse => {
                AppServerErrorName::ExtensionsInstallationInUse
            }
            ExtensionsErrorCode::StorageUnavailable | ExtensionsErrorCode::ServiceUnavailable => {
                AppServerErrorName::ExtensionsUnavailable
            }
            ExtensionsErrorCode::InvalidRequest | ExtensionsErrorCode::MethodNotFound => {
                AppServerErrorName::ExtensionsOperationFailed
            }
        },
    };
    RpcError::new(-32101, name)
}

impl AppServer {
    pub(super) fn extension_sources(&self, params: &Value) -> Result<Value, RpcError> {
        let _: EmptyParams = decode(params)?;
        let manager = self
            .plugins_manager
            .as_ref()
            .ok_or_else(|| extension_packages_error(ExtensionsClientError::unavailable()))?;
        sources_result(manager.sources().map_err(extension_packages_error)?)
    }

    pub(super) fn extension_source_add(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::extension_packages::ExtensionsAddSourceParams = decode(params)?;
        let id = ash_plugin::ExtensionSourceId::new(params.source_id)
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let manager = self
            .plugins_manager
            .as_ref()
            .ok_or_else(|| extension_packages_error(ExtensionsClientError::unavailable()))?;
        sources_result(
            manager
                .add_source(
                    ash_core_plugins::AshExtensionSourceConfig {
                        id,
                        metadata_base_url: params.metadata_base_url,
                        targets_base_url: params.targets_base_url,
                        trusted_root_json: params.trusted_root_json,
                        enabled: true,
                    },
                    params.expected_revision,
                )
                .map_err(extension_packages_error)?,
        )
    }

    pub(super) fn extension_source_set_enabled(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::extension_packages::ExtensionsSetSourceEnabledParams = decode(params)?;
        let id = ash_plugin::ExtensionSourceId::new(params.source_id)
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let manager = self
            .plugins_manager
            .as_ref()
            .ok_or_else(|| extension_packages_error(ExtensionsClientError::unavailable()))?;
        sources_result(
            manager
                .set_source_enabled(&id, params.enabled, params.expected_revision)
                .map_err(extension_packages_error)?,
        )
    }
}

fn sources_result(snapshot: ash_core_plugins::ExtensionSourcesSnapshot) -> Result<Value, RpcError> {
    use ash_app_server_protocol::protocol::extension_packages::ExtensionRegistryKindDto;
    use ash_app_server_protocol::protocol::extension_packages::ExtensionsSourceDto;
    use ash_app_server_protocol::protocol::extension_packages::ExtensionsSourcesResult;
    result(&ExtensionsSourcesResult {
        revision: snapshot.revision,
        sources: snapshot
            .sources
            .into_iter()
            .map(|source| ExtensionsSourceDto {
                id: source.id.to_string(),
                kind: match source.kind {
                    ash_core_plugins::ExtensionRegistryKind::OpenVsx => {
                        ExtensionRegistryKindDto::OpenVsx
                    }
                    ash_core_plugins::ExtensionRegistryKind::Ash => ExtensionRegistryKindDto::Ash,
                },
                enabled: source.enabled,
                product_owned: source.product_owned,
            })
            .collect(),
    })
}
