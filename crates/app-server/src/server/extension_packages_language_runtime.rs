use std::sync::Arc;

use ash_core_plugins::CapabilityKind;
use ash_core_plugins::ExtensionPackageManager;
use ash_lsp_server_provider::DirectPackageLanguageServerProvider;
use ash_lsp_server_provider::LspServerProviders;
use ash_lsp_server_provider::ManagedNodeRuntime;
use ash_lsp_server_provider::NodePackageLanguageServerProvider;

/// Composes installed Extensions executable capabilities into language-server providers.
#[derive(Clone)]
pub(crate) struct ExtensionsLanguageRuntime {
    manager: Arc<ExtensionPackageManager>,
    node: Option<ManagedNodeRuntime>,
    base: LspServerProviders,
    policy: Option<Arc<ash_core_plugins::EditorExtensionPolicy>>,
    // Stable identities let consumers distinguish an unrelated catalog change from a new
    // version, digest, entrypoint, runtime or language route of the same server ID.
    providers: Arc<
        std::sync::Mutex<std::collections::BTreeMap<String, Arc<PackageLanguageServerProvider>>>,
    >,
}

impl ExtensionsLanguageRuntime {
    pub(crate) fn new(
        manager: Arc<ExtensionPackageManager>,
        node: Option<ManagedNodeRuntime>,
        base: LspServerProviders,
    ) -> Self {
        Self {
            manager,
            node,
            base,
            policy: None,
            providers: Arc::new(Default::default()),
        }
    }

    pub(crate) fn set_editor_extension_policy(
        &mut self,
        policy: Arc<ash_core_plugins::EditorExtensionPolicy>,
    ) {
        self.policy = Some(policy);
    }

    pub(super) fn subscribe(&self) -> Result<std::sync::mpsc::Receiver<u64>, String> {
        self.manager.subscribe().map_err(|error| error.to_string())
    }

    pub(crate) fn providers(&self) -> Result<LspServerProviders, String> {
        let executables = self
            .manager
            .local_capability_source_snapshot(CapabilityKind::Executable)
            .map_err(|error| error.to_string())?;
        let mut providers = self.base.clone();
        let mut cached = self
            .providers
            .lock()
            .map_err(|_| "language-server provider cache is unavailable")?;
        let mut retained = std::collections::BTreeSet::new();
        for (package, error) in executables.failures {
            log::error!(
                "language-server package {} is unavailable: {error}",
                package.id
            );
        }
        let mut identities = std::collections::BTreeMap::<String, usize>::new();
        for source in &executables.sources {
            *identities.entry(source.id().to_owned()).or_default() += 1;
        }
        for executable in executables.sources {
            if identities[executable.id()] > 1 || self.base.contains(executable.id()) {
                log::error!(
                    "conflicting language-server package identity: {}",
                    executable.id()
                );
                continue;
            }
            if self.policy.as_ref().is_some_and(|policy| {
                !policy
                    .snapshot(executable.package(), executable.capability())
                    .enabled
            }) {
                continue;
            }
            let languages = executable.language_ids();
            if languages.is_empty() {
                continue;
            }
            if let Some(provider) = cached
                .get(executable.id())
                .filter(|provider| provider.source == executable)
            {
                providers
                    .register_packaged_shared(provider.clone())
                    .map_err(|error| error.to_string())?;
                retained.insert(executable.id().to_owned());
                continue;
            }
            let provider =
                (|| -> Result<Box<dyn ash_lsp_server_provider::LanguageServerProvider>, String> {
                    match executable.runtime().unwrap_or("node") {
                        "node" => Ok(Box::new(
                            NodePackageLanguageServerProvider::new(
                                executable.id(),
                                languages.iter().cloned(),
                                executable.host_path(),
                                self.node.clone().ok_or_else(|| {
                                    "managed Node-compatible runtime is unavailable".to_owned()
                                })?,
                            )
                            .map_err(|error| error.to_string())?,
                        )),
                        "direct" => Ok(Box::new(
                            DirectPackageLanguageServerProvider::new(
                                executable.id(),
                                languages.iter().cloned(),
                                executable.host_path(),
                            )
                            .map_err(|error| error.to_string())?,
                        )),
                        runtime => Err(format!("unsupported language-server runtime: {runtime}")),
                    }
                })();
            match provider {
                Ok(provider) => {
                    let id = executable.id().to_owned();
                    let provider = Arc::new(PackageLanguageServerProvider {
                        manager: Arc::clone(&self.manager),
                        source: executable,
                        provider,
                    });
                    providers
                        .register_packaged_shared(provider.clone())
                        .map_err(|error| error.to_string())?;
                    cached.insert(id.clone(), provider);
                    retained.insert(id);
                }
                Err(error) => log::error!(
                    "language server {} is unavailable: {error}",
                    executable.id()
                ),
            }
        }
        cached.retain(|id, _| retained.contains(id));
        Ok(providers)
    }
}

// The provider owns discovery metadata; only a resolved manager definition owns a live lease.
struct PackageLanguageServerProvider {
    manager: Arc<ExtensionPackageManager>,
    source: ash_core_plugins::LocalCapabilitySource,
    provider: Box<dyn ash_lsp_server_provider::LanguageServerProvider>,
}

impl ash_lsp_server_provider::LanguageServerProvider for PackageLanguageServerProvider {
    fn id(&self) -> &str {
        self.provider.id()
    }
    fn languages(&self) -> &[String] {
        self.provider.languages()
    }
    fn definition(
        &self,
        root: &std::path::Path,
        launch: ash_lsp_server_provider::LspServerLaunch<'_>,
    ) -> Result<
        ash_lsp_server_provider::LanguageServerDefinition,
        ash_lsp_server_provider::LanguageServerProviderError,
    > {
        let lease = self
            .manager
            .acquire_local_source(&self.source)
            .map_err(|error| {
                ash_lsp_server_provider::LanguageServerProviderError::PackageUnavailable(
                    error.to_string(),
                )
            })?;
        let lease = LanguageServerPackageLease {
            manager: Arc::clone(&self.manager),
            id: lease.id,
        };
        Ok(self.provider.definition(root, launch)?.with_lease(lease))
    }
}

struct LanguageServerPackageLease {
    manager: Arc<ExtensionPackageManager>,
    id: String,
}
impl Drop for LanguageServerPackageLease {
    fn drop(&mut self) {
        use ash_core_plugins::ExtensionPackageService;
        if let Err(error) =
            self.manager
                .release_capability(ash_core_plugins::ReleaseCapabilityRequest {
                    lease_id: self.id.clone(),
                })
        {
            log::error!("failed to release language-server package: {error}");
        }
    }
}

/// Read only product-owned declarations from the same frozen catalog served to the workbench.
/// Installing a user/registry package never grants permission to probe or download executables.
pub(super) fn language_server_contributions(
    snapshot: &ash_external_ext::packages::ExtensionPackagesSnapshot,
) -> Result<
    std::collections::BTreeMap<String, Vec<ash_lsp_server_provider::LanguageServerAcquisition>>,
    String,
> {
    use ash_external_ext::packages::ExtensionSourceKind;
    use ash_lsp_server_provider::LanguageServerAcquisition;
    let mut contributions = std::collections::BTreeMap::new();
    let mut ids = std::collections::BTreeSet::new();
    for extension in &snapshot.extensions {
        if extension.source_kind != ExtensionSourceKind::BuiltIn {
            continue;
        }
        let manifest: serde_json::Value =
            serde_json::from_str(&extension.manifest_json).map_err(|error| error.to_string())?;
        let Some(value) = manifest.get("ashLanguageServers") else {
            continue;
        };
        let mut servers = LanguageServerAcquisition::from_contribution(value.clone())
            .map_err(|error| format!("{}: {error}", extension.id))?;
        for server in &mut servers {
            server
                .bind_package(&extension.extension_location)
                .map_err(|error| format!("{}: {error}", extension.id))?;
        }
        for server in &servers {
            if !ids.insert(server.id.clone()) {
                return Err(format!(
                    "duplicate language-server contribution: {}",
                    server.id
                ));
            }
        }
        contributions.insert(extension.id.clone(), servers);
    }
    Ok(contributions)
}
