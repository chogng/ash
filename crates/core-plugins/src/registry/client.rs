use sha2::Digest;
use sha2::Sha256;
use std::sync::Mutex;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use crate::DownloadPackageRequest;
use crate::ExtensionPackagePayload;
use crate::ExtensionSource;

use crate::ExtensionsClientError;
use crate::GetPackageRequest;
use crate::PackageDetails;
use crate::SearchPackagesRequest;
use crate::SearchPackagesResult;
use crate::registry::catalog::Catalog;
use crate::registry::remote::RemoteExtensionsConfig;

const DEFAULT_SEARCH_LIMIT: usize = 50;
const MAX_SEARCH_LIMIT: usize = 200;

/// HTTPS/TUF client for one product-pinned remote Extensions distribution.
pub struct ExtensionsRemoteClient {
    config: RemoteExtensionsConfig,
    catalog: Mutex<Option<Catalog>>,
}

impl ExtensionsRemoteClient {
    /// Creates a lazy remote client without making App Server startup depend on network access.
    pub fn new(config: RemoteExtensionsConfig) -> Self {
        Self {
            config,
            catalog: Mutex::new(None),
        }
    }

    fn with_catalog<T>(
        &self,
        operation: impl FnOnce(&Catalog) -> Result<T, ExtensionsClientError>,
    ) -> Result<T, ExtensionsClientError> {
        let mut catalog = self
            .catalog
            .lock()
            .map_err(|_| ExtensionsClientError::unavailable())?;
        if catalog.is_none() {
            *catalog = Some(Catalog::load_remote(self.config.clone())?);
        }
        operation(catalog.as_ref().expect("catalog was initialized"))
    }
}

impl ExtensionSource for ExtensionsRemoteClient {
    fn search_page(
        &self,
        request: crate::SearchPackagesPageRequest,
    ) -> Result<crate::SearchPackagesPageResult, ExtensionsClientError> {
        self.with_catalog(|catalog| {
            let (packages, identities) = catalog.search_snapshot(&request.search)?;
            let packages = packages
                .into_iter()
                .map(|mut package| {
                    package.id = plugin_name(&package.id);
                    package
                })
                .collect();
            catalog_page(&request, packages, &identities)
        })
    }

    fn search(
        &self,
        request: SearchPackagesRequest,
    ) -> Result<SearchPackagesResult, ExtensionsClientError> {
        // This signed catalog's package format has no VSIX/editorExtension capability.
        // An explicit Open VSX filter must not make an unrelated registry network request.
        if request.capability_kind == Some(crate::CapabilityKind::EditorExtension)
            || request.package_type.as_deref() == Some("editorExtension")
        {
            return Ok(SearchPackagesResult {
                unavailable_sources: Vec::new(),
                packages: Vec::new(),
            });
        }
        let limit = request
            .limit
            .unwrap_or(DEFAULT_SEARCH_LIMIT)
            .clamp(1, MAX_SEARCH_LIMIT);
        self.with_catalog(|catalog| {
            Ok(SearchPackagesResult {
                unavailable_sources: Vec::new(),
                packages: catalog
                    .search(&request, limit)?
                    .into_iter()
                    .map(|mut package| {
                        package.id = plugin_name(&package.id);
                        package
                    })
                    .collect(),
            })
        })
    }

    fn get(&self, request: GetPackageRequest) -> Result<PackageDetails, ExtensionsClientError> {
        let package_id = package_id(&request.package_id)?;
        self.with_catalog(|catalog| {
            let mut details = catalog
                .resolve(&package_id, request.version.as_deref())?
                .details();
            details.package.id = plugin_name(&details.package.id);
            Ok(details)
        })
    }

    fn download(
        &self,
        request: DownloadPackageRequest,
    ) -> Result<Box<dyn ExtensionPackagePayload>, ExtensionsClientError> {
        let package_id = package_id(&request.package_id)?;
        self.with_catalog(|catalog| {
            let release = catalog.resolve_fresh(&package_id, request.version.as_deref())?;
            Ok(Box::new(catalog.materialize(&release)?) as Box<dyn ExtensionPackagePayload>)
        })
    }
}

// Bind an offset to the exact query and verified metadata. A refreshed catalog invalidates old pages
// rather than letting additions or removals silently skip or repeat packages.
fn catalog_page(
    request: &crate::SearchPackagesPageRequest,
    packages: Vec<crate::PackageSummary>,
    identities: &[crate::PackageRef],
) -> Result<crate::SearchPackagesPageResult, ExtensionsClientError> {
    let limit = request
        .search
        .limit
        .filter(|limit| (1..=200).contains(limit))
        .ok_or_else(|| ExtensionsClientError::invalid_request("invalid page size"))?;
    let bytes = serde_json::to_vec(&(&request.source_id, &request.search, &packages, identities))
        .map_err(|_| ExtensionsClientError::unavailable())?;
    let fingerprint = format!("{:x}", Sha256::digest(bytes));
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ExtensionsClientError::unavailable())?
        .as_secs();
    let (offset, expires) = match request.cursor.as_deref() {
        None => (0, now + 1800),
        Some(cursor) => {
            let parts = cursor.split(':').collect::<Vec<_>>();
            let invalid = || {
                ExtensionsClientError::invalid_request(
                    "catalog cursor is invalid or expired; start a new query",
                )
            };
            if parts.len() != 3 || parts[0] != fingerprint {
                return Err(invalid());
            }
            let offset = parts[1].parse::<usize>().map_err(|_| invalid())?;
            let expires = parts[2].parse::<u64>().map_err(|_| invalid())?;
            if expires <= now || expires > now + 1800 || offset == 0 || offset >= packages.len() {
                return Err(invalid());
            }
            (offset, expires)
        }
    };
    let total = packages.len();
    let next = offset.saturating_add(limit).min(total);
    Ok(crate::SearchPackagesPageResult {
        packages: packages.into_iter().skip(offset).take(limit).collect(),
        total,
        next_cursor: (next < total).then(|| format!("{fingerprint}:{next}:{expires}")),
    })
}

pub(super) fn plugin_name(package_id: &str) -> String {
    package_id.replace('/', ".")
}

fn package_id(plugin_name: &str) -> Result<String, ExtensionsClientError> {
    let (publisher, name) = plugin_name.split_once('.').ok_or_else(|| {
        ExtensionsClientError::invalid_request(
            "this registry requires a publisher-qualified plugin name",
        )
    })?;
    ash_utils_plugins::PluginPackageId::new(format!("{publisher}/{name}"))
        .map(|id| id.to_string())
        .map_err(|_| ExtensionsClientError::invalid_request("invalid registry plugin name"))
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
