//! Shared Plugin identities, manifests, paths, and validated package observations.

mod error;
mod identity;
mod manifest;
mod package;
mod package_id;
mod path;
mod plugin_id;

pub use error::{PluginError, PluginErrorKind};
pub use identity::{
    InstalledPluginRef, InvalidPluginPackageDigest, InvalidPluginVersion, PluginPackageDigest,
    PluginVersion,
};
pub use manifest::{
    AshVersionRequirement, AssetContribution, ConnectorContribution, ContributionKind,
    ContributionReference, CredentialKind, CredentialSlot, DeclarativeExtensionContribution,
    DirectoryAccess, EditorExtensionActivationEvent, EditorExtensionCapability,
    EditorExtensionContribution, EditorExtensionRuntimeApiVersion, InvalidContributionReference,
    InvalidManifestLocalId, InvalidNetworkHost, InvalidVersionRequirement, ManifestLocalId,
    McpServerContribution, NetworkHost, Permission, PluginCompatibility, PluginContributions,
    PluginManifest, SkillContribution,
};
pub use package::{
    LocalPluginCatalog, LocalPluginPackage, PackageFileStats, PluginPackageDigestAlgorithm,
    PluginPackageSource,
};
pub use path::{InvalidPluginPath, PluginPath};

pub use package_id::InvalidPluginPackageId;
pub use package_id::PluginPackageId;
pub use plugin_id::InvalidPluginId;
pub use plugin_id::MarketplaceName;
pub use plugin_id::PluginId;
