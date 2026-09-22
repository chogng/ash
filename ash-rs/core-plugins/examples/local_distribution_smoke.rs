use std::env;
use std::error::Error;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use ash_core_plugins::CapabilityKind;
use ash_core_plugins::InstallPackageRequest;
use ash_core_plugins::MarketplaceRemoteClient;
use ash_core_plugins::PluginPackageService;
use ash_core_plugins::PluginsManager;
use ash_core_plugins::RemoteMarketplaceConfig;
use ash_core_plugins::SearchPackagesRequest;

fn main() -> Result<(), Box<dyn Error>> {
    let arguments = env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let [distribution, trusted_root, state_root] = arguments.as_slice() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: local_distribution_smoke <distribution> <trusted-root> <state-root>",
        )
        .into());
    };
    let config = RemoteMarketplaceConfig::from_directory(
        distribution,
        std::fs::read(trusted_root)?,
        state_root.join("remote-cache"),
    )?;
    let registry = Arc::new(MarketplaceRemoteClient::new(config));
    let providers = ash_core_plugins::PluginProviders::new([(
        ash_plugin::MarketplaceName::new("local")?,
        registry as Arc<dyn ash_core_plugins::PluginProvider>,
    )])?;
    let manager = PluginsManager::open(state_root.join("manager"), providers)?;
    for (package_type, package_id) in [
        ("plugin", "marketplace/github"),
        ("skill", "marketplace/commit"),
        ("language", "marketplace/css"),
        ("mcp", "marketplace/playwright-mcp"),
        ("theme", "marketplace/aurora-theme"),
    ] {
        let source_id = format!("{}@local", package_id.replace('/', "."));
        let search = manager.search(SearchPackagesRequest {
            query: package_id.rsplit('/').next().unwrap_or_default().to_owned(),
            package_type: Some(package_type.to_owned()),
            limit: Some(10),
            ..SearchPackagesRequest::default()
        })?;
        let package = search
            .packages
            .iter()
            .find(|package| package.id == source_id)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("{package_id} package was not found"),
                )
            })?;
        let installed = manager.install(InstallPackageRequest {
            package_id: package.id.clone(),
            version: Some(package.version.clone()),
        })?;
        println!(
            "installed {}@{} with {} capabilities as {}",
            installed.package.id,
            installed.package.version,
            installed.capabilities.len(),
            installed.installation_id
        );
    }
    let skill_sources = manager.local_capability_sources(CapabilityKind::Skill)?;
    let mcp_sources = manager.local_capability_sources(CapabilityKind::Mcp)?;
    let connector_sources = manager.local_capability_sources(CapabilityKind::Connector)?;
    let theme_sources = manager.local_capability_sources(CapabilityKind::Theme)?;
    let language_sources = manager.local_capability_sources(CapabilityKind::Language)?;
    let executable_sources = manager.local_capability_sources(CapabilityKind::Executable)?;
    if skill_sources.is_empty()
        || mcp_sources.is_empty()
        || connector_sources.is_empty()
        || theme_sources.is_empty()
        || language_sources.is_empty()
    {
        return Err(io::Error::other(
            "installed packages were not projected across every declarative capability kind",
        )
        .into());
    }
    let css_server = executable_sources
        .iter()
        .find(|source| source.package().id == "marketplace.css@local")
        .ok_or_else(|| io::Error::other("CSS executable capability was not projected"))?;
    if css_server.language_ids() != ["css", "less", "scss"] {
        return Err(io::Error::other("CSS executable lost its signed language route").into());
    }
    Ok(())
}
