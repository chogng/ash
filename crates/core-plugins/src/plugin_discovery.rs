use crate::LocalPluginCatalog;
use crate::PluginPackageSource;
use ash_tools::CapabilityDiscoveryId;
use ash_tools::CapabilityDiscoverySnapshot;
use ash_tools::DiscoverableCapability;
use ash_tools::DiscoverableContributionKinds;
use ash_tools::DiscoverablePluginInfo;
use ash_tools::DiscoveryAction;
use ash_tools::DiscoveryValueError;
use std::collections::BTreeSet;

/// Projects validated local Plugin packages into the catalog-only tool discovery contract.
///
/// `requested` contains exact `id@version` values present in config. This function performs no
/// installation, enablement, grant, or runtime registration.
pub fn project_local_plugin_discovery(
    generation: u64,
    catalog: &LocalPluginCatalog,
    requested: &BTreeSet<String>,
) -> Result<CapabilityDiscoverySnapshot, DiscoveryValueError> {
    let candidates = catalog
        .list()
        .iter()
        .map(|package| {
            let manifest = package.manifest();
            let exact_id = format!("{}@{}", manifest.id, manifest.version);
            let action = if requested.contains(&exact_id) {
                DiscoveryAction::Enable
            } else {
                DiscoveryAction::Install
            };
            let source = match package.source() {
                PluginPackageSource::BuiltIn => "built-in",
                PluginPackageSource::LocalDevelopment { .. } => "local-development",
            };
            DiscoverableCapability::Plugin(DiscoverablePluginInfo {
                id: CapabilityDiscoveryId::new(exact_id)
                    .expect("validated Plugin identity and version are non-empty"),
                display_name: manifest.display_name.clone(),
                description: manifest
                    .description
                    .clone()
                    .unwrap_or_else(|| format!("{source} Plugin package {}", manifest.id)),
                contributions: DiscoverableContributionKinds {
                    skills: !manifest.contributions.skills.is_empty(),
                    tools: !manifest.contributions.mcp_servers.is_empty(),
                    connectors: !manifest.contributions.connectors.is_empty(),
                },
                action,
            })
        })
        .collect();
    CapabilityDiscoverySnapshot::new(generation, candidates)
}

#[cfg(test)]
#[path = "plugin_discovery_tests.rs"]
mod tests;
