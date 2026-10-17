//! Exercise signed localization distribution through the production package manager.

use std::env;
use std::error::Error;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use ash_core_plugins::AcquireCapabilityRequest;
use ash_core_plugins::ActivationSpec;
use ash_core_plugins::CapabilityKind;
use ash_core_plugins::ExtensionPackageManager;
use ash_core_plugins::ExtensionPackageService;
use ash_core_plugins::ExtensionSource;
use ash_core_plugins::ExtensionSources;
use ash_core_plugins::ExtensionsRemoteClient;
use ash_core_plugins::InstallPackageRequest;
use ash_core_plugins::ListInstalledRequest;
use ash_core_plugins::OpenResourceRequest;
use ash_core_plugins::ReleaseCapabilityRequest;
use ash_core_plugins::RemoteExtensionsConfig;
use ash_core_plugins::SearchPackagesRequest;
use ash_core_plugins::UninstallMode;
use ash_core_plugins::UninstallPackageRequest;
use ash_utils_plugins::ExtensionSourceId;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use url::Url;

fn main() -> Result<(), Box<dyn Error>> {
    let arguments = env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let [distribution, trusted_root, state_root] = arguments.as_slice() else {
        return Err(io::Error::other(
            "usage: localization_distribution_smoke <distribution-directory-or-https-url> <trusted-root> <empty-state-root>",
        )
        .into());
    };
    let source = distribution.to_string_lossy();
    let root = std::fs::read(trusted_root)?;
    let config = if source.starts_with("https://") {
        let base = Url::parse(&source)?;
        RemoteExtensionsConfig::new(
            base.join("metadata/")?,
            base.join("targets/")?,
            root,
            state_root.join("cache"),
        )?
    } else {
        RemoteExtensionsConfig::from_directory(distribution, root, state_root.join("cache"))?
    };
    let registry = Arc::new(ExtensionsRemoteClient::new(config));
    let providers = ExtensionSources::new([(
        ExtensionSourceId::new("ash")?,
        registry as Arc<dyn ExtensionSource>,
    )])?;
    let manager = ExtensionPackageManager::open(state_root.join("manager"), providers)?;
    assert!(manager.list_installed(ListInstalledRequest {})?.is_empty());
    let found = manager.search(SearchPackagesRequest {
        query: "ash-language-fr".into(),
        package_type: Some("localization".into()),
        ..SearchPackagesRequest::default()
    })?;
    let package = found
        .packages
        .iter()
        .find(|package| package.id == "marketplace.ash-language-fr@ash")
        .ok_or_else(|| {
            io::Error::other(format!("French localization was not discovered: {found:?}"))
        })?;
    let installed = manager.install(InstallPackageRequest {
        package_id: package.id.clone(),
        version: Some(package.version.clone()),
    })?;
    let capability = installed
        .capabilities
        .iter()
        .find(|capability| capability.kind == CapabilityKind::Localization)
        .ok_or_else(|| io::Error::other("Localization capability was not installed"))?;
    let acquired = manager.acquire_capability(AcquireCapabilityRequest {
        capability: capability.reference.clone(),
    })?;
    let ActivationSpec::Localization(spec) = acquired.spec else {
        return Err(io::Error::other("Localization acquired an executable capability").into());
    };
    let content = manager.open_resource(OpenResourceRequest {
        lease_id: acquired.lease.id.clone(),
        resource: spec.catalog,
    })?;
    let catalog: serde_json::Value =
        serde_json::from_slice(&STANDARD.decode(content.data_base64)?)?;
    assert_eq!(catalog["locale"], "fr");
    assert_eq!(catalog["catalogVersion"], "ash-1");
    assert_eq!(
        catalog["bundles"]["ash.settings"]["displayLanguage.configure"],
        "Configurer la langue d’affichage"
    );
    manager.release_capability(ReleaseCapabilityRequest {
        lease_id: acquired.lease.id,
    })?;
    manager.uninstall(UninstallPackageRequest {
        installation_id: installed.installation_id,
        mode: UninstallMode::IfUnused,
    })?;
    assert!(manager.list_installed(ListInstalledRequest {})?.is_empty());
    println!(
        "French signed package: discovered, installed, read through a lease, released and uninstalled"
    );
    Ok(())
}
