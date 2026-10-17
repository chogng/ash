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
        }
    }

    pub(crate) fn set_editor_extension_policy(
        &mut self,
        policy: Arc<ash_core_plugins::EditorExtensionPolicy>,
    ) {
        self.policy = Some(policy);
    }

    pub(crate) fn providers(&self) -> Result<LspServerProviders, String> {
        let executables = self
            .manager
            .local_capability_sources(CapabilityKind::Executable)
            .map_err(|error| error.to_string())?;
        let mut providers = self.base.clone();
        for executable in executables {
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
            match executable.runtime().unwrap_or("node") {
                "node" => {
                    let node = self.node.clone().ok_or_else(|| {
                        format!(
                            "Extensions language server '{}' requires the managed Node-compatible runtime",
                            executable.id()
                        )
                    })?;
                    let provider = NodePackageLanguageServerProvider::new(
                        executable.id(),
                        languages.iter().cloned(),
                        executable.host_path(),
                        node,
                    )
                    .map_err(|error| error.to_string())?;
                    providers
                        .register_packaged(provider)
                        .map_err(|error| error.to_string())?;
                }
                "direct" => {
                    let provider = DirectPackageLanguageServerProvider::new(
                        executable.id(),
                        languages.iter().cloned(),
                        executable.host_path(),
                    )
                    .map_err(|error| error.to_string())?;
                    providers
                        .register_packaged(provider)
                        .map_err(|error| error.to_string())?;
                }
                runtime => {
                    return Err(format!(
                        "Extensions language server '{}' declares unsupported runtime '{runtime}'",
                        executable.id()
                    ));
                }
            }
        }
        Ok(providers)
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
        let servers = LanguageServerAcquisition::from_contribution(value.clone())
            .map_err(|error| format!("{}: {error}", extension.id))?;
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
