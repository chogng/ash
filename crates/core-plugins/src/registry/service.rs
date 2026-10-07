use crate::AcquireCapabilityRequest;
use crate::AcquiredCapability;
use crate::ArtifactHandle;
use crate::DownloadPackageRequest;
use crate::GetPackageRequest;
use crate::InstallPackageRequest;
use crate::InstalledPackage;
use crate::ListInstalledRequest;
use crate::MarketplaceClientError;
use crate::OpenResourceRequest;
use crate::PackageDetails;
use crate::ReleaseCapabilityOutcome;
use crate::ReleaseCapabilityRequest;
use crate::ResourceContent;
use crate::SearchPackagesRequest;
use crate::SearchPackagesResult;
use crate::UninstallPackageRequest;
use crate::UpdatePackageRequest;

/// Plugin package service implemented by [`crate::PluginsManager`].
///
/// Core Plugins uses this interface for remote discovery and local lifecycle operations.
/// Implementations must keep remote protocol, cache, package paths, and filesystem layout private.
pub trait PluginPackageService: Send + Sync {
    fn search(
        &self,
        request: SearchPackagesRequest,
    ) -> Result<SearchPackagesResult, MarketplaceClientError>;

    fn get(&self, request: GetPackageRequest) -> Result<PackageDetails, MarketplaceClientError>;

    fn download(
        &self,
        request: DownloadPackageRequest,
    ) -> Result<ArtifactHandle, MarketplaceClientError>;

    fn install(
        &self,
        request: InstallPackageRequest,
    ) -> Result<InstalledPackage, MarketplaceClientError>;

    fn update(
        &self,
        request: UpdatePackageRequest,
    ) -> Result<InstalledPackage, MarketplaceClientError>;

    fn uninstall(&self, request: UninstallPackageRequest) -> Result<(), MarketplaceClientError>;

    fn list_installed(
        &self,
        request: ListInstalledRequest,
    ) -> Result<Vec<InstalledPackage>, MarketplaceClientError>;

    fn acquire_capability(
        &self,
        request: AcquireCapabilityRequest,
    ) -> Result<AcquiredCapability, MarketplaceClientError>;

    fn release_capability(
        &self,
        request: ReleaseCapabilityRequest,
    ) -> Result<ReleaseCapabilityOutcome, MarketplaceClientError>;

    fn open_resource(
        &self,
        request: OpenResourceRequest,
    ) -> Result<ResourceContent, MarketplaceClientError>;
}
