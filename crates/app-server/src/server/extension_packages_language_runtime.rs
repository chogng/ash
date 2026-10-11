use std::sync::Arc;

use ash_core_plugins::CapabilityKind;
use ash_core_plugins::ExtensionPackageManager;
use ash_lsp_server_provider::DirectPackageLanguageServerProvider;
use ash_lsp_server_provider::LspServerProviders;
use ash_lsp_server_provider::ManagedNodeRuntime;
use ash_lsp_server_provider::NodePackageLanguageServerProvider;

/// Composes installed Extensions executable capabilities into language-server providers.
pub(crate) struct ExtensionsLanguageRuntime {
    manager: Arc<ExtensionPackageManager>,
    node: Option<ManagedNodeRuntime>,
    base: LspServerProviders,
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
        }
    }

    pub(crate) fn providers(&self) -> Result<LspServerProviders, String> {
        let executables = self
            .manager
            .local_capability_sources(CapabilityKind::Executable)
            .map_err(|error| error.to_string())?;
        let mut providers = self.base.clone();
        for executable in executables {
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
