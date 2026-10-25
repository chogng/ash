//! Plugin manifests, paths, and validated package observations.

mod error;
mod identity;
mod manifest;
mod package;
mod path;

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

use ash_utils_plugins::PluginPackageId;

pub use manifest::EditorExtensionApi;
pub use manifest::EditorExtensionRuntime;
pub use manifest::ExtensionUiTarget;
