use ash_core_plugins::PluginActivationAuthority;
use extension_catalog::DynamicExtensionPackageSource;
use extension_catalog::DynamicExtensionSourceProvider;
use extension_catalog::DynamicExtensionSourceSnapshot;

/// Projects exact effective Plugin declarative Extension packages into the static catalog.
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
