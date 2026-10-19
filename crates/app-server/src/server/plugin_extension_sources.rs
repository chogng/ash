use ash_core_plugins::PluginActivationAuthority;
use ash_external_ext::packages::DynamicExtensionPackageSource;
use ash_external_ext::packages::DynamicExtensionSourceProvider;
use ash_external_ext::packages::DynamicExtensionSourceSnapshot;
use ash_external_ext::packages::ExtensionRuntimeBinding;
use ash_plugin::EditorExtensionApi;
use ash_plugin::EditorExtensionRuntime;

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
                .find(|contribution| {
                    contribution.api == EditorExtensionApi::Vscode
                        && contribution.runtime == EditorExtensionRuntime::JavaScript
                })
                .or_else(|| {
                    package
                        .manifest()
                        .contributions
                        .editor_extensions
                        .iter()
                        .find(|contribution| contribution.api == EditorExtensionApi::Vscode)
                })
            {
                // The standard module and its declarations share this immutable package root;
                // discovery must not require another independently enabled contribution.
                let mut source = DynamicExtensionPackageSource::plugin(
                    format!("{}:{}", package.manifest().id, contribution.id.as_str()),
                    package.package_root(),
                );
                if contribution.runtime == EditorExtensionRuntime::JavaScript {
                    source.runtime_binding = Some(ExtensionRuntimeBinding {
                        runtime_id: source.subject.clone(),
                        package_digest: package.package_digest().as_str().to_string(),
                    });
                }
                packages.push(source);
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
            diagnostics: Vec::new(),
        })
    }
}

#[cfg(test)]
#[path = "plugin_extension_sources_tests.rs"]
mod tests;
