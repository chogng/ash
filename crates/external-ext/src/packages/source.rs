use std::path::PathBuf;

use super::ExtensionDiagnostic;

/// Host-authorized client resources for one exact executable editor runtime.
///
/// This fact comes from the package authority and its execution policy, never from declarative
/// manifest discovery. Resource consumers still verify the frozen script and stylesheet bytes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtensionRendererClient {
    pub runtime_id: String,
    pub api_version: u32,
    pub entry: String,
    pub digest: String,
    pub style: String,
    pub style_digest: String,
    pub source_digest: String,
}

/// Identifies the provenance of a static extension package.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExtensionRootKind {
    /// A package shipped with the product installation.
    BuiltIn,
    /// A package selected by the effective Plugin authority snapshot.
    Plugin,
    /// A package installed by the local Extensions Manager.
    Registry,
    /// A package installed below the user's trusted profile extension directory.
    User,
}

/// Filesystem root containing direct-child extension packages.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtensionRoot {
    /// Provenance reported in catalog diagnostics and descriptors.
    pub kind: ExtensionRootKind,
    /// Root path supplied by the host composition root.
    pub path: PathBuf,
}

impl ExtensionRoot {
    /// Creates a built-in extension root.
    pub fn built_in(path: impl Into<PathBuf>) -> Self {
        Self {
            kind: ExtensionRootKind::BuiltIn,
            path: path.into(),
        }
    }

    /// Creates a user extension root.
    pub fn user(path: impl Into<PathBuf>) -> Self {
        Self {
            kind: ExtensionRootKind::User,
            path: path.into(),
        }
    }
}

/// One exact declarative extension package selected by an external authority snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DynamicExtensionPackageSource {
    /// Stable authority-owned label used in diagnostics.
    pub subject: String,
    /// Exact package directory containing `package.json`.
    pub path: PathBuf,
    /// Verified package provenance projected into the catalog.
    pub kind: ExtensionRootKind,
    /// Optional host-normalized declarative manifest for a portable package family.
    ///
    /// The catalog still snapshots and hashes the exact package directory. This value may only
    /// adapt its manifest contract; it cannot add files or bypass package path validation.
    pub normalized_manifest_json: Option<String>,
    /// Exact complete-package digest already verified by the source authority.
    /// This can differ from a snapshot of the capability's resource subtree.
    pub verified_package_sha256: Option<String>,
    /// Execution admission supplied by the host; manifest fields cannot create this fact.
    pub renderer_client: Option<ExtensionRendererClient>,
    /// Optional executable identity selected by the same trusted package authority.
    /// This is host metadata, never a field read from the extension's manifest.
    pub runtime_binding: Option<ExtensionRuntimeBinding>,
}

/// Connects an authority-owned executable package to its declarative catalog snapshot.
/// The runtime package digest retains its own domain; it does not replace the catalog hash.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtensionRuntimeBinding {
    pub runtime_id: String,
    pub package_digest: String,
}

impl DynamicExtensionPackageSource {
    /// Creates a Plugin-authorized exact package source.
    pub fn plugin(subject: impl Into<String>, path: impl Into<PathBuf>) -> Self {
        Self {
            subject: subject.into(),
            path: path.into(),
            kind: ExtensionRootKind::Plugin,
            normalized_manifest_json: None,
            verified_package_sha256: None,
            renderer_client: None,
            runtime_binding: None,
        }
    }

    /// Creates a Extensions-authorized exact package source.
    pub fn extension_packages(subject: impl Into<String>, path: impl Into<PathBuf>) -> Self {
        Self {
            subject: subject.into(),
            path: path.into(),
            kind: ExtensionRootKind::Registry,
            normalized_manifest_json: None,
            verified_package_sha256: None,
            renderer_client: None,
            runtime_binding: None,
        }
    }

    /// Creates a Extensions source with one host-normalized declarative manifest.
    pub fn extension_packages_with_manifest(
        subject: impl Into<String>,
        path: impl Into<PathBuf>,
        normalized_manifest_json: impl Into<String>,
    ) -> Self {
        Self {
            subject: subject.into(),
            path: path.into(),
            kind: ExtensionRootKind::Registry,
            normalized_manifest_json: Some(normalized_manifest_json.into()),
            verified_package_sha256: None,
            renderer_client: None,
            runtime_binding: None,
        }
    }
}

/// Immutable exact extension package set published by a dynamic authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DynamicExtensionSourceSnapshot {
    /// Monotonically changing authority generation.
    pub generation: u64,
    /// Exact package directories in stable authority order.
    pub packages: Vec<DynamicExtensionPackageSource>,
    /// Failures isolated to one authority or package; healthy sources remain available.
    pub diagnostics: Vec<ExtensionDiagnostic>,
}

/// Supplies exact extension package directories without transferring lifecycle ownership.
///
/// Implementations must return only immutable paths selected by their own live authority. The
/// catalog validates and freezes each package before exposing descriptors or resource bytes. An
/// unchanged generation and exact source may reuse those frozen bytes, including on refresh.
/// Change the generation whenever the authorized package set or its contents change.
pub trait DynamicExtensionSourceProvider: Send + Sync {
    /// Returns the current authority generation and exact package sources.
    fn snapshot(&self) -> Result<DynamicExtensionSourceSnapshot, String>;
}
