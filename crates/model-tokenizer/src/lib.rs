//! Pinned local tokenizer assets and provider-neutral chat prompt measurement.

mod binding;
mod catalog;
mod discovery;
mod downloader;
mod error;
mod manager;
mod registry;
mod request;

pub use binding::LocalTokenizerBinding;
pub use binding::PinnedTokenizerAsset;
pub use catalog::RemoteTokenizerAsset;
pub use catalog::TokenizerAssetCatalog;
pub use catalog::TokenizerAssetManifest;
pub use discovery::TokenizerAssetDiscoverer;
pub use downloader::HttpTokenizerAssetDownloader;
pub use downloader::TokenizerAssetDownloader;
pub use error::LocalTokenizerError;
pub use manager::ManagedLocalTokenizerService;
pub use manager::MemoryTokenizerCapacity;
pub use manager::TokenizerPreparationStatus;
pub use registry::LocalTokenCount;
pub use registry::LocalTokenizationOutcome;
pub use registry::LocalTokenizerRegistry;
pub use registry::LocalTokenizerService;

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "manager_tests.rs"]
mod manager_tests;
