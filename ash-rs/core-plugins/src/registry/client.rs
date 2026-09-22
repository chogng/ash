use std::sync::Mutex;

use crate::DownloadPackageRequest;
use crate::PluginPackagePayload;
use crate::PluginProvider;

use crate::GetPackageRequest;
use crate::MarketplaceClientError;
use crate::PackageDetails;
use crate::SearchPackagesRequest;
use crate::SearchPackagesResult;
use crate::registry::catalog::Catalog;
use crate::registry::remote::RemoteMarketplaceConfig;

const DEFAULT_SEARCH_LIMIT: usize = 50;
const MAX_SEARCH_LIMIT: usize = 200;

/// HTTPS/TUF client for one product-pinned remote Marketplace distribution.
pub struct MarketplaceRemoteClient {
    config: RemoteMarketplaceConfig,
    catalog: Mutex<Option<Catalog>>,
}

impl MarketplaceRemoteClient {
    /// Creates a lazy remote client without making App Server startup depend on network access.
    pub fn new(config: RemoteMarketplaceConfig) -> Self {
        Self {
            config,
            catalog: Mutex::new(None),
        }
    }

    fn with_catalog<T>(
        &self,
        operation: impl FnOnce(&Catalog) -> Result<T, MarketplaceClientError>,
    ) -> Result<T, MarketplaceClientError> {
        let mut catalog = self
            .catalog
            .lock()
            .map_err(|_| MarketplaceClientError::unavailable())?;
        if catalog.is_none() {
            *catalog = Some(Catalog::load_remote(self.config.clone())?);
        }
        operation(catalog.as_ref().expect("catalog was initialized"))
    }
}

impl PluginProvider for MarketplaceRemoteClient {
    fn search(
        &self,
        request: SearchPackagesRequest,
    ) -> Result<SearchPackagesResult, MarketplaceClientError> {
        let limit = request
            .limit
            .unwrap_or(DEFAULT_SEARCH_LIMIT)
            .clamp(1, MAX_SEARCH_LIMIT);
        self.with_catalog(|catalog| {
            Ok(SearchPackagesResult {
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

    fn get(&self, request: GetPackageRequest) -> Result<PackageDetails, MarketplaceClientError> {
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
    ) -> Result<Box<dyn PluginPackagePayload>, MarketplaceClientError> {
        let package_id = package_id(&request.package_id)?;
        self.with_catalog(|catalog| {
            let release = catalog.resolve_fresh(&package_id, request.version.as_deref())?;
            Ok(Box::new(catalog.materialize(&release)?) as Box<dyn PluginPackagePayload>)
        })
    }
}

pub(super) fn plugin_name(package_id: &str) -> String {
    package_id.replace('/', ".")
}

fn package_id(plugin_name: &str) -> Result<String, MarketplaceClientError> {
    let (publisher, name) = plugin_name.split_once('.').ok_or_else(|| {
        MarketplaceClientError::invalid_request(
            "this registry requires a publisher-qualified plugin name",
        )
    })?;
    ash_plugin::PluginPackageId::new(format!("{publisher}/{name}"))
        .map(|id| id.to_string())
        .map_err(|_| MarketplaceClientError::invalid_request("invalid registry plugin name"))
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
