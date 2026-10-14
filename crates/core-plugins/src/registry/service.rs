use crate::AcquireCapabilityRequest;
use crate::AcquiredCapability;
use crate::ArtifactHandle;
use crate::DownloadPackageRequest;
use crate::ExtensionsClientError;
use crate::GetPackageRequest;
use crate::InstallPackageRequest;
use crate::InstalledPackage;
use crate::ListInstalledRequest;
use crate::OpenResourceRequest;
use crate::PackageDetails;
use crate::ReleaseCapabilityOutcome;
use crate::ReleaseCapabilityRequest;
use crate::ResourceContent;
use crate::SearchPackagesRequest;
use crate::SearchPackagesResult;
use crate::UninstallPackageRequest;
use crate::UpdatePackageRequest;

/// Plugin package service implemented by [`crate::ExtensionPackageManager`].
///
/// Core Plugins uses this interface for remote discovery and local lifecycle operations.
/// Implementations must keep remote protocol, cache, package paths, and filesystem layout private.
pub trait ExtensionPackageService: Send + Sync {
    fn search_page(
        &self,
        request: crate::SearchPackagesPageRequest,
    ) -> Result<crate::SearchPackagesPageResult, ExtensionsClientError>;

    fn search(
        &self,
        request: SearchPackagesRequest,
    ) -> Result<SearchPackagesResult, ExtensionsClientError>;

    fn get(&self, request: GetPackageRequest) -> Result<PackageDetails, ExtensionsClientError>;

    fn download(
        &self,
        request: DownloadPackageRequest,
    ) -> Result<ArtifactHandle, ExtensionsClientError>;

    fn install(
        &self,
        request: InstallPackageRequest,
    ) -> Result<InstalledPackage, ExtensionsClientError>;

    fn update(
        &self,
        request: UpdatePackageRequest,
    ) -> Result<InstalledPackage, ExtensionsClientError>;

    fn uninstall(&self, request: UninstallPackageRequest) -> Result<(), ExtensionsClientError>;

    fn list_installed(
        &self,
        request: ListInstalledRequest,
    ) -> Result<Vec<InstalledPackage>, ExtensionsClientError>;

    fn acquire_capability(
        &self,
        request: AcquireCapabilityRequest,
    ) -> Result<AcquiredCapability, ExtensionsClientError>;

    fn release_capability(
        &self,
        request: ReleaseCapabilityRequest,
    ) -> Result<ReleaseCapabilityOutcome, ExtensionsClientError>;

    fn open_resource(
        &self,
        request: OpenResourceRequest,
    ) -> Result<ResourceContent, ExtensionsClientError>;
}
