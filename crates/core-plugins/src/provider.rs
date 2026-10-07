use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use crate::CapabilityKind;
use crate::DownloadPackageRequest;
use crate::GetPackageRequest;
use crate::MarketplaceClientError;
use crate::MarketplaceErrorCode;
use crate::PackageDetails;
use crate::PackageRef;
use crate::SearchPackagesRequest;
use crate::SearchPackagesResult;
use ash_plugin::MarketplaceName;
use ash_plugin::PluginId;

/// Manager-only normalized capability layout carried with one verified download.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginPackageCapability {
    pub kind: CapabilityKind,
    pub id: String,
    pub path: String,
    pub runtime: Option<String>,
    pub language_ids: Vec<String>,
}

/// Source-owned, inert package payload handed from a provider to the local manager.
///
/// Implementations must keep source paths private and may only copy into an empty
/// Manager-owned staging directory.
pub trait PluginPackagePayload: Send {
    fn package(&self) -> &crate::PackageRef;
    fn capabilities(&self) -> &[PluginPackageCapability];
    fn expected_file_count(&self) -> u64;
    fn expected_size_bytes(&self) -> u64;
    fn copy_to(&self, destination: &Path) -> Result<(), MarketplaceClientError>;
}

/// Source provider consumed by the profile-owned Plugin manager.
///
/// Implementations own source discovery, trust verification, and package resolution. They
/// return normalized DTOs and verified payloads; local installation, update, uninstall, leases,
/// and activation remain the Manager's responsibility. Package IDs here are unqualified plugin
/// names; the provider translates its own package format and must never activate contributions.
pub trait PluginProvider: Send + Sync {
    fn search(
        &self,
        request: SearchPackagesRequest,
    ) -> Result<SearchPackagesResult, MarketplaceClientError>;

    fn get(&self, request: GetPackageRequest) -> Result<PackageDetails, MarketplaceClientError>;

    fn download(
        &self,
        request: DownloadPackageRequest,
    ) -> Result<Box<dyn PluginPackagePayload>, MarketplaceClientError>;
}

/// Named sources with exact routing and source-bound package identities.
///
/// Providers only resolve packages. The manager owns installation, resources, and lifecycle.
/// Registration is immutable for the lifetime of a profile authority.
pub struct PluginProviders {
    providers: BTreeMap<MarketplaceName, Arc<dyn PluginProvider>>,
}

impl PluginProviders {
    pub fn new(
        providers: impl IntoIterator<Item = (MarketplaceName, Arc<dyn PluginProvider>)>,
    ) -> Result<Self, MarketplaceClientError> {
        let mut registered = BTreeMap::new();
        for (name, provider) in providers {
            if registered.insert(name, provider).is_some() {
                return Err(MarketplaceClientError::invalid_request(
                    "duplicate marketplace name",
                ));
            }
        }
        Ok(Self {
            providers: registered,
        })
    }

    pub(crate) fn search(
        &self,
        mut request: SearchPackagesRequest,
    ) -> Result<SearchPackagesResult, MarketplaceClientError> {
        let limit = request.limit.unwrap_or(50).clamp(1, 200);
        request.limit = Some(limit);
        let mut packages = Vec::new();
        for (name, provider) in &self.providers {
            for mut package in provider.search(request.clone())?.packages {
                package.id = source_id(&package.id, name)?.to_string();
                if semver::Version::parse(&package.version).is_err() {
                    return Err(MarketplaceClientError::package_untrusted());
                }
                packages.push(package);
            }
        }
        packages.sort_by(|left, right| (&left.id, &left.version).cmp(&(&right.id, &right.version)));
        if packages
            .windows(2)
            .any(|pair| pair[0].id == pair[1].id && pair[0].version == pair[1].version)
        {
            return Err(MarketplaceClientError::package_untrusted());
        }
        packages.truncate(limit);
        Ok(SearchPackagesResult { packages })
    }

    pub(crate) fn get(
        &self,
        request: GetPackageRequest,
    ) -> Result<PackageDetails, MarketplaceClientError> {
        let (id, provider) = self.route(&request.package_id)?;
        validate_version(request.version.as_deref())?;
        let mut details = provider.get(GetPackageRequest {
            package_id: id.plugin_name().to_owned(),
            version: request.version.clone(),
        })?;
        validate_resolved(&id, request.version.as_deref(), &details.package)?;
        details.package.id = id.to_string();
        Ok(details)
    }

    pub(crate) fn download(
        &self,
        request: DownloadPackageRequest,
    ) -> Result<Box<dyn PluginPackagePayload>, MarketplaceClientError> {
        let (id, provider) = self.route(&request.package_id)?;
        validate_version(request.version.as_deref())?;
        let payload = provider.download(DownloadPackageRequest {
            package_id: id.plugin_name().to_owned(),
            version: request.version.clone(),
        })?;
        validate_resolved(&id, request.version.as_deref(), payload.package())?;
        let mut package = payload.package().clone();
        package.id = id.to_string();
        Ok(Box::new(SourcePackage { package, payload }))
    }

    /// The previous manager stored one signed registry without a source name. A legacy profile
    /// can be bound only while its original source is the sole configured provider.
    pub(crate) fn legacy_id(&self, value: &str) -> Result<PluginId, MarketplaceClientError> {
        let mut names = self.providers.keys();
        let name = names.next().filter(|_| names.next().is_none()).ok_or_else(|| {
            MarketplaceClientError::invalid_request(
                "existing installations have no marketplace identity; reopen once with only their original marketplace configured before adding sources",
            )
        })?;
        let package = ash_plugin::PluginPackageId::new(value)
            .map_err(|_| MarketplaceClientError::storage())?;
        PluginId::new(package.as_str().replace('/', "."), name.clone())
            .map_err(|_| MarketplaceClientError::storage())
    }

    fn route(
        &self,
        value: &str,
    ) -> Result<(PluginId, &dyn PluginProvider), MarketplaceClientError> {
        let id = PluginId::parse(value)
            .map_err(|error| MarketplaceClientError::invalid_request(error.to_string()))?;
        let provider = self.providers.get(id.marketplace()).ok_or_else(|| {
            MarketplaceClientError::business(
                MarketplaceErrorCode::PackageNotFound,
                "plugin marketplace is not configured",
                false,
            )
        })?;
        Ok((id, provider.as_ref()))
    }
}

fn source_id(
    value: &str,
    marketplace: &MarketplaceName,
) -> Result<PluginId, MarketplaceClientError> {
    PluginId::new(value, marketplace.clone())
        .map_err(|_| MarketplaceClientError::package_untrusted())
}

fn validate_resolved(
    requested: &PluginId,
    version: Option<&str>,
    package: &PackageRef,
) -> Result<(), MarketplaceClientError> {
    if package.id != requested.plugin_name()
        || version.is_some_and(|version| version != package.version)
        || semver::Version::parse(&package.version).is_err()
        || ash_plugin::PluginPackageDigest::new(&package.digest).is_err()
    {
        return Err(MarketplaceClientError::package_untrusted());
    }
    Ok(())
}

fn validate_version(version: Option<&str>) -> Result<(), MarketplaceClientError> {
    if version.is_some_and(|value| semver::Version::parse(value).is_err()) {
        return Err(MarketplaceClientError::invalid_request(
            "plugin version must be an exact semantic version",
        ));
    }
    Ok(())
}

struct SourcePackage {
    package: PackageRef,
    payload: Box<dyn PluginPackagePayload>,
}

impl PluginPackagePayload for SourcePackage {
    fn package(&self) -> &PackageRef {
        &self.package
    }
    fn capabilities(&self) -> &[PluginPackageCapability] {
        self.payload.capabilities()
    }
    fn expected_file_count(&self) -> u64 {
        self.payload.expected_file_count()
    }
    fn expected_size_bytes(&self) -> u64 {
        self.payload.expected_size_bytes()
    }
    fn copy_to(&self, destination: &Path) -> Result<(), MarketplaceClientError> {
        self.payload.copy_to(destination)
    }
}
