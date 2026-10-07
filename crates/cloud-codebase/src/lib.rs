//! Optional cloud semantic enhancement for one directory Codebase.
//!
//! This crate owns egress grants, provider contracts, publication/deletion state, and the
//! publication of directory-produced chunks. Scanning, ignore semantics, chunking, chunk identity,
//! and current-source verification remain in `ash-codebase`; remote services never receive
//! authority to traverse or rechunk the codebase.

mod controller;
mod error;
mod provider;
mod store;
mod types;

pub use controller::CloudCodebaseController;
pub use error::CloudCodebaseError;
pub use error::CloudCodebaseProviderError;
pub use provider::CloudCodebaseProvider;
pub use provider::CloudCodebaseProviderRegistry;
pub use types::CloudCodebaseCandidate;
pub use types::CloudCodebaseCapabilities;
pub use types::CloudCodebaseDeletionSupport;
pub use types::CloudCodebaseDestination;
pub use types::CloudCodebaseGrant;
pub use types::CloudCodebaseGrantId;
pub use types::CloudCodebaseId;
pub use types::CloudCodebaseLimitDisposition;
pub use types::CloudCodebasePreview;
pub use types::CloudCodebaseProviderId;
pub use types::CloudCodebasePublication;
pub use types::CloudCodebasePublicationRequest;
pub use types::CloudCodebaseQuery;
pub use types::CloudCodebaseQueryRequest;
pub use types::CloudCodebaseQueryResult;
pub use types::CloudCodebaseSelection;
pub use types::CloudCodebaseState;
pub use types::CloudCodebaseStatus;
pub use types::CloudCodebaseStorage;
pub use types::CodebaseDeploymentMode;

#[cfg(test)]
#[path = "cloud_codebase_tests.rs"]
mod tests;
