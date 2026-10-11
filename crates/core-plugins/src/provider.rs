use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use crate::CapabilityKind;
use crate::DownloadPackageRequest;
use crate::ExtensionsClientError;
use crate::ExtensionsErrorCode;
use crate::GetPackageRequest;
use crate::PackageDetails;
use crate::PackageRef;
use crate::SearchPackagesRequest;
use crate::SearchPackagesResult;
use ash_plugin::ExtensionSourceId;
use ash_plugin::PluginId;

/// Manager-only normalized capability layout carried with one verified download.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtensionPackageCapability {
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
pub trait ExtensionPackagePayload: Send {
    fn package(&self) -> &crate::PackageRef;
    fn capabilities(&self) -> &[ExtensionPackageCapability];
    fn expected_file_count(&self) -> u64;
    fn expected_size_bytes(&self) -> u64;
    fn copy_to(&self, destination: &Path) -> Result<(), ExtensionsClientError>;
}

/// Source provider consumed by the profile-owned Extensions package manager.
///
/// Implementations own source discovery, trust verification, and package resolution. They
/// return normalized DTOs and verified payloads; local installation, update, uninstall, leases,
/// and activation remain the Manager's responsibility. Package IDs here are unqualified plugin
/// names; the provider translates its own package format and must never activate contributions.
pub trait ExtensionSource: Send + Sync {
    fn registry_kind(&self) -> crate::ExtensionRegistryKind {
        crate::ExtensionRegistryKind::Ash
    }
    /// Resource URL contract for a provider whose verified packages contain editor extensions.
    fn extension_gallery_resource_url_template(&self) -> Option<String> {
        None
    }

    fn search(
        &self,
        request: SearchPackagesRequest,
    ) -> Result<SearchPackagesResult, ExtensionsClientError>;

    fn get(&self, request: GetPackageRequest) -> Result<PackageDetails, ExtensionsClientError>;

    fn download(
        &self,
        request: DownloadPackageRequest,
    ) -> Result<Box<dyn ExtensionPackagePayload>, ExtensionsClientError>;
}

/// Named sources with exact routing and source-bound package identities.
///
/// Providers only resolve packages. The manager owns installation, resources, and lifecycle.
/// Registration is immutable for the lifetime of a profile authority.
#[derive(Clone)]
pub struct ExtensionSources {
    pub(super) disabled: std::collections::BTreeSet<ExtensionSourceId>,
    pub(super) providers: BTreeMap<ExtensionSourceId, Arc<dyn ExtensionSource>>,
}

impl ExtensionSources {
    pub(crate) fn extension_gallery(
        &self,
    ) -> Result<Option<(&ExtensionSourceId, &dyn ExtensionSource, String)>, ExtensionsClientError>
    {
        let mut galleries = self.providers.iter().filter_map(|(name, provider)| {
            provider
                .extension_gallery_resource_url_template()
                .map(|template| (name, provider.as_ref(), template))
        });
        let gallery = galleries.next();
        if galleries.next().is_some() {
            return Err(ExtensionsClientError::invalid_request(
                "multiple extension resource galleries are configured",
            ));
        }
        Ok(gallery)
    }

    pub fn new(
        providers: impl IntoIterator<Item = (ExtensionSourceId, Arc<dyn ExtensionSource>)>,
    ) -> Result<Self, ExtensionsClientError> {
        let mut registered = BTreeMap::new();
        for (name, provider) in providers {
            if registered.insert(name, provider).is_some() {
                return Err(ExtensionsClientError::invalid_request(
                    "duplicate extension source ID",
                ));
            }
        }
        Ok(Self {
            providers: registered,
            disabled: Default::default(),
        })
    }

    pub(crate) fn search(
        &self,
        mut request: SearchPackagesRequest,
    ) -> Result<SearchPackagesResult, ExtensionsClientError> {
        let limit = request.limit.unwrap_or(50).clamp(1, 200);
        request.limit = Some(limit);
        let mut packages = Vec::new();
        let mut unavailable_sources = Vec::new();
        for (name, provider) in &self.providers {
            if self.disabled.contains(name) {
                continue;
            }
            let result = match provider.search(request.clone()) {
                Ok(result) => result,
                Err(_) => {
                    unavailable_sources.push(name.to_string());
                    continue;
                }
            };
            let normalized = result
                .packages
                .into_iter()
                .map(|mut package| {
                    package.id = source_id(&package.id, name)?.to_string();
                    semver::Version::parse(&package.version)
                        .map_err(|_| ExtensionsClientError::package_untrusted())?;
                    Ok(package)
                })
                .collect::<Result<Vec<_>, ExtensionsClientError>>();
            let Ok(mut normalized) = normalized else {
                unavailable_sources.push(name.to_string());
                continue;
            };
            normalized
                .sort_by(|left, right| (&left.id, &left.version).cmp(&(&right.id, &right.version)));
            if normalized
                .windows(2)
                .any(|pair| pair[0].id == pair[1].id && pair[0].version == pair[1].version)
            {
                unavailable_sources.push(name.to_string());
                continue;
            }
            packages.extend(normalized);
        }
        packages.sort_by(|left, right| (&left.id, &left.version).cmp(&(&right.id, &right.version)));
        packages.truncate(limit);
        Ok(SearchPackagesResult {
            packages,
            unavailable_sources,
        })
    }

    pub(crate) fn get(
        &self,
        request: GetPackageRequest,
    ) -> Result<PackageDetails, ExtensionsClientError> {
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
    ) -> Result<Box<dyn ExtensionPackagePayload>, ExtensionsClientError> {
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
    pub(crate) fn legacy_id(&self, value: &str) -> Result<PluginId, ExtensionsClientError> {
        let mut names = self.providers.keys();
        let name = names.next().filter(|_| names.next().is_none()).ok_or_else(|| {
            ExtensionsClientError::invalid_request(
                "existing installations have no source identity; reopen once with only their original source configured before adding sources",
            )
        })?;
        let package = ash_plugin::PluginPackageId::new(value)
            .map_err(|_| ExtensionsClientError::storage())?;
        PluginId::new(package.as_str().replace('/', "."), name.clone())
            .map_err(|_| ExtensionsClientError::storage())
    }

    fn route(
        &self,
        value: &str,
    ) -> Result<(PluginId, &dyn ExtensionSource), ExtensionsClientError> {
        let id = PluginId::parse(value)
            .map_err(|error| ExtensionsClientError::invalid_request(error.to_string()))?;
        if self.disabled.contains(id.source_id()) {
            return Err(ExtensionsClientError::unavailable());
        }
        let provider = self.providers.get(id.source_id()).ok_or_else(|| {
            ExtensionsClientError::business(
                ExtensionsErrorCode::PackageNotFound,
                "extension source is not configured",
                false,
            )
        })?;
        Ok((id, provider.as_ref()))
    }
}

fn source_id(
    value: &str,
    extension_packages: &ExtensionSourceId,
) -> Result<PluginId, ExtensionsClientError> {
    PluginId::new(value, extension_packages.clone())
        .map_err(|_| ExtensionsClientError::package_untrusted())
}

fn validate_resolved(
    requested: &PluginId,
    version: Option<&str>,
    package: &PackageRef,
) -> Result<(), ExtensionsClientError> {
    if package.id != requested.plugin_name()
        || version.is_some_and(|version| version != package.version)
        || semver::Version::parse(&package.version).is_err()
        || ash_plugin::PluginPackageDigest::new(&package.digest).is_err()
    {
        return Err(ExtensionsClientError::package_untrusted());
    }
    Ok(())
}

fn validate_version(version: Option<&str>) -> Result<(), ExtensionsClientError> {
    if version.is_some_and(|value| semver::Version::parse(value).is_err()) {
        return Err(ExtensionsClientError::invalid_request(
            "plugin version must be an exact semantic version",
        ));
    }
    Ok(())
}

struct SourcePackage {
    package: PackageRef,
    payload: Box<dyn ExtensionPackagePayload>,
}

impl ExtensionPackagePayload for SourcePackage {
    fn package(&self) -> &PackageRef {
        &self.package
    }
    fn capabilities(&self) -> &[ExtensionPackageCapability] {
        self.payload.capabilities()
    }
    fn expected_file_count(&self) -> u64 {
        self.payload.expected_file_count()
    }
    fn expected_size_bytes(&self) -> u64 {
        self.payload.expected_size_bytes()
    }
    fn copy_to(&self, destination: &Path) -> Result<(), ExtensionsClientError> {
        self.payload.copy_to(destination)
    }
}
