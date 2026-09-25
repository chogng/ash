//! Provider-independent model discovery, caching, resolution, effective metadata, and instructions.

mod cache;
mod disk_cache;
mod error;
mod filter;
mod instructions;
mod manager;
mod merge;
mod model_info;
mod policy;
mod scope;
mod snapshot;
mod source;

pub use error::ModelsManagerError;
pub use filter::AvailabilityFilter;
pub use filter::CatalogQuery;
pub use filter::ModelCapability;
pub use filter::ModelRequirements;
pub use filter::UnknownCapabilityPolicy;
pub use instructions::ModelInstructionCatalog;
pub use instructions::ModelInstructionError;
pub use instructions::ModelInstructionProfile;
pub use manager::CatalogReadSource;
pub use manager::ModelsManager;
pub use model_info::ResolvedModel;
pub use policy::CatalogFreshnessPolicy;
pub use policy::CatalogReadPolicy;
pub use scope::CatalogScopeKey;
pub use scope::CatalogSourceScopeId;
pub use scope::InvalidCatalogScope;
pub use snapshot::CatalogGeneration;
pub use snapshot::CatalogWarning;
pub use snapshot::CatalogWarningCode;
pub use snapshot::MetadataSource;
pub use snapshot::ModelCapabilitiesProvenance;
pub use snapshot::ModelCatalogEntry;
pub use snapshot::ModelCatalogSnapshot;
pub use snapshot::ModelMetadataProvenance;
pub use source::CatalogCacheHint;
pub use source::CatalogDiscoveryOutcome;
pub use source::CatalogDiscoveryRequest;
pub use source::CatalogNotModified;
pub use source::CatalogSourceError;
pub use source::CatalogSourceErrorKind;
pub use source::CatalogSourceFuture;
pub use source::CatalogValidator;
pub use source::DiscoveredCatalog;
pub use source::DiscoveredModel;
pub use source::DiscoveryCoverage;
pub use source::ModelCapabilitiesPatch;
pub use source::ModelCatalogSource;
pub use source::ModelMetadataPatch;

pub use ash_protocol::ModelAvailability;
pub use ash_protocol::ModelCatalogFreshness;
pub use ash_protocol::ModelLifecycle;
pub use ash_protocol::ModelMetadataQuality;

#[cfg(test)]
#[path = "manager_tests.rs"]
mod tests;
