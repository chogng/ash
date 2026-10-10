use ash_core_plugins::PluginActivationAuthority;
use ash_plugin::EditorExtensionApi;
use extension_catalog::DynamicExtensionPackageSource;
use extension_catalog::DynamicExtensionSourceProvider;
use extension_catalog::DynamicExtensionSourceSnapshot;

/// Selects declarative and standard API package manifests from the same effective Plugin snapshot.
pub(super) struct PluginExtensionSourceProvider {
    authority: PluginActivationAuthority,
}

impl PluginExtensionSourceProvider {
    pub(super) fn new(authority: PluginActivationAuthority) -> Self {
        Self { authority }
    }
}

impl DynamicExtensionSourceProvider for PluginExtensionSourceProvider {
    fn snapshot(&self) -> Result<DynamicExtensionSourceSnapshot, String> {
        let activation = self.authority.snapshot().activation().clone();
        let mut packages = Vec::new();
        for package in activation.packages() {
            if let Some(contribution) = package
                .manifest()
                .contributions
                .editor_extensions
                .iter()
                .find(|contribution| contribution.api == EditorExtensionApi::Vscode)
            {
                // The standard module and its declarations share this immutable package root;
                // discovery must not require another independently enabled contribution.
                packages.push(DynamicExtensionPackageSource::plugin(
                    format!("{}:{}", package.manifest().id, contribution.id.as_str()),
                    package.package_root(),
                ));
            }
            for contribution in &package.manifest().contributions.declarative_extensions {
                let root = package
                    .resolve_directory(&contribution.path)
                    .map_err(|error| error.to_string())?;
                packages.push(DynamicExtensionPackageSource::plugin(
                    format!("{}:{}", package.manifest().id, contribution.id.as_str()),
                    root,
                ));
            }
        }
        Ok(DynamicExtensionSourceSnapshot {
            generation: activation.generation(),
            packages,
        })
    }
}

#[cfg(test)]
#[path = "plugin_extension_sources_tests.rs"]
mod tests;
