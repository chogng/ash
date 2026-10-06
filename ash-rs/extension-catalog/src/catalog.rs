use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;

use crate::catalog_budget::CatalogBudget;
use crate::catalog_budget::CatalogLimit;
use crate::diagnostic::diagnostic;
use crate::package::ExtensionPackageSnapshot;
use crate::package::MAX_MANIFEST_BYTES;
use crate::package::PackageSnapshotError;
use crate::package::PackageSnapshotLimits;
use crate::resource::is_within;
use crate::resource::mime_type;
use crate::resource::validate_relative_path;
use crate::source::DynamicExtensionPackageSource;
use crate::source::DynamicExtensionSourceProvider;
use crate::source::DynamicExtensionSourceSnapshot;
use crate::source::ExtensionRoot;
use crate::source::ExtensionRootKind;

const MAX_EXTENSION_ID_LENGTH: usize = 160;
const MAX_MANIFEST_FIELD_LENGTH: usize = 256;

/// Selects whether a catalog query may reuse its previous discovery snapshot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExtensionCatalogReload {
    /// Return the previous snapshot, scanning only when no snapshot exists yet.
    Cached,
    /// Rescan all configured roots, publishing a new generation only when contents change.
    Refresh,
}

/// Static metadata exposed to a host after manifest identity validation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtensionDescriptor {
    /// Canonical `publisher.name` extension identity.
    pub id: String,
    /// Manifest `name` component.
    pub name: String,
    /// Manifest `publisher` component.
    pub publisher: String,
    /// Manifest `version` value.
    pub version: String,
    /// Validated display name, defaulting to `name` when omitted.
    pub display_name: String,
    /// Trusted root provenance.
    pub source_kind: ExtensionSourceKind,
    /// Canonical JSON representation of the complete manifest.
    pub manifest_json: String,
    /// SHA-256 digest of the canonical JSON bytes exposed in `manifest_json`.
    pub manifest_sha256: String,
    /// Deterministic SHA-256 digest of every frozen regular file in the package.
    pub package_sha256: String,
}

/// Provenance attached to a discovered extension descriptor.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExtensionSourceKind {
    /// The package came from the product installation.
    BuiltIn,
    /// The package came from an effective, exact Plugin package.
    Plugin,
    /// The package came from the local Marketplace Manager.
    Marketplace,
    /// The package came from the user's profile extension directory.
    User,
}

/// Stable diagnostic category for a package discovery failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExtensionDiagnosticCode {
    /// A configured root could not be read.
    SourceUnavailable,
    /// The package manifest is absent or malformed.
    InvalidManifest,
    /// A later root attempted to register an already-used extension ID.
    DuplicateExtension,
    /// A package contains an unsafe filesystem entry or violates root containment.
    PathEscapesRoot,
    /// A requested package resource does not exist or is not a file.
    ResourceNotFound,
    /// A package or catalog exceeded a configured count or byte limit.
    ResourceTooLarge,
}

/// Diagnostic emitted while scanning an extension root.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtensionDiagnostic {
    /// Human-readable root provenance label.
    pub source: String,
    /// Root child or other subject associated with the diagnostic.
    pub subject: Option<String>,
    /// Stable diagnostic category.
    pub code: ExtensionDiagnosticCode,
    /// Diagnostic message suitable for logs and host presentation.
    pub message: String,
}

/// Immutable result of one extension catalog generation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtensionCatalogSnapshot {
    /// Monotonically increasing generation of the catalog contents.
    pub generation: u64,
    /// Successfully discovered extensions in deterministic order.
    pub extensions: Vec<ExtensionDescriptor>,
    /// Non-fatal discovery diagnostics in deterministic scan order.
    pub diagnostics: Vec<ExtensionDiagnostic>,
}

/// Resource bytes read from a discovered extension package.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtensionResource {
    /// MIME type inferred from the resource extension.
    pub mime_type: String,
    /// Bounded resource bytes.
    pub bytes: Vec<u8>,
}

/// Failure returned when a host requests an extension or package resource.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExtensionCatalogError {
    /// The caller requested a resource from a catalog generation that is no longer current.
    GenerationConflict,
    /// The extension ID is not in the latest discovered catalog.
    NotFound,
    /// The requested relative path is unsafe.
    InvalidPath,
    /// The requested resource is absent or not a regular file.
    ResourceNotFound,
    /// The resource exceeds the shared static resource limit.
    ResourceTooLarge,
    /// The host filesystem operation failed for another reason.
    OperationFailed,
}

#[derive(Default)]
pub struct ExtensionCatalog {
    roots: Vec<ExtensionRoot>,
    dynamic_sources: Option<Arc<dyn DynamicExtensionSourceProvider>>,
    dynamic_generation: Option<u64>,
    generation: u64,
    snapshot: Option<ExtensionCatalogSnapshot>,
    discovered: BTreeMap<String, DiscoveredExtension>,
}

struct DiscoveredExtension {
    package: ExtensionPackageSnapshot,
    descriptor: ExtensionDescriptor,
}

impl ExtensionCatalog {
    /// Creates a catalog from trusted built-in and user roots.
    pub fn new(roots: Vec<ExtensionRoot>) -> Self {
        Self {
            roots,
            ..Self::default()
        }
    }

    /// Binds an authority-owned source of exact immutable extension package directories.
    pub fn with_dynamic_sources(
        mut self,
        provider: Arc<dyn DynamicExtensionSourceProvider>,
    ) -> Self {
        self.bind_dynamic_sources(provider);
        self
    }

    /// Rebinds the dynamic authority and invalidates any snapshot from the previous provider.
    pub fn bind_dynamic_sources(&mut self, provider: Arc<dyn DynamicExtensionSourceProvider>) {
        self.dynamic_sources = Some(provider);
        self.dynamic_generation = None;
        self.snapshot = None;
        self.discovered.clear();
    }

    /// Reports whether at least one host-configured root exists.
    pub fn is_available(&self) -> bool {
        !self.roots.is_empty() || self.dynamic_sources.is_some()
    }

    /// Lists extensions, rescanning roots when requested or when no snapshot exists.
    pub fn list(&mut self, reload: ExtensionCatalogReload) -> ExtensionCatalogSnapshot {
        let dynamic = self
            .dynamic_sources
            .as_ref()
            .map(|provider| provider.snapshot());
        let dynamic_unchanged = match &dynamic {
            None => true,
            Some(Ok(snapshot)) => self.dynamic_generation == Some(snapshot.generation),
            Some(Err(_)) => false,
        };
        if reload == ExtensionCatalogReload::Cached
            && dynamic_unchanged
            && let Some(snapshot) = &self.snapshot
        {
            return snapshot.clone();
        }
        let dynamic_snapshot = dynamic.as_ref().and_then(|result| result.as_ref().ok());
        let dynamic_error = dynamic.as_ref().and_then(|result| result.as_ref().err());
        let (extensions, diagnostics, discovered) =
            self.scan(dynamic_snapshot, dynamic_error.map(String::as_str));
        self.dynamic_generation = dynamic_snapshot.map(|snapshot| snapshot.generation);
        // Independent renderers and contribution loaders refresh the same catalog.
        // A scan alone must not invalidate their in-flight frozen-resource reads.
        // Descriptors include package digests, so resource-only changes still advance it.
        if let Some(snapshot) = &self.snapshot
            && snapshot.extensions == extensions
            && snapshot.diagnostics == diagnostics
        {
            return snapshot.clone();
        }
        self.generation = self
            .generation
            .checked_add(1)
            .expect("extension catalog generation overflow");
        self.discovered = discovered;
        let snapshot = ExtensionCatalogSnapshot {
            generation: self.generation,
            extensions,
            diagnostics,
        };
        self.snapshot = Some(snapshot.clone());
        snapshot
    }

    /// Opens one bounded resource frozen into the requested current catalog generation.
    pub fn open_resource(
        &mut self,
        generation: u64,
        extension_id: &str,
        path: &str,
    ) -> Result<ExtensionResource, ExtensionCatalogError> {
        if self.snapshot.is_none() {
            let _ = self.list(ExtensionCatalogReload::Cached);
        }
        if generation != self.generation {
            return Err(ExtensionCatalogError::GenerationConflict);
        }
        let extension = self
            .discovered
            .get(extension_id)
            .ok_or(ExtensionCatalogError::NotFound)?;
        let relative_path = validate_relative_path(path)?;
        let key = relative_path
            .iter()
            .map(|segment| segment.to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let bytes = extension
            .package
            .file(&key)
            .ok_or(ExtensionCatalogError::ResourceNotFound)?
            .to_vec();
        Ok(ExtensionResource {
            mime_type: mime_type(&relative_path),
            bytes,
        })
    }

    fn scan(
        &self,
        dynamic: Option<&DynamicExtensionSourceSnapshot>,
        dynamic_error: Option<&str>,
    ) -> (
        Vec<ExtensionDescriptor>,
        Vec<ExtensionDiagnostic>,
        BTreeMap<String, DiscoveredExtension>,
    ) {
        let mut extensions = Vec::new();
        let mut diagnostics = Vec::new();
        let mut discovered = BTreeMap::new();
        let mut budget = CatalogBudget::default();
        for root in self
            .roots
            .iter()
            .filter(|root| root.kind == ExtensionRootKind::BuiltIn)
        {
            if scan_root(
                root,
                &mut extensions,
                &mut diagnostics,
                &mut discovered,
                &mut budget,
            ) == CatalogScanControl::Stop
            {
                break;
            }
        }
        if let Some(error) = dynamic_error {
            budget.push_diagnostic(
                &mut diagnostics,
                ExtensionDiagnostic {
                    source: "plugin".into(),
                    subject: None,
                    code: ExtensionDiagnosticCode::SourceUnavailable,
                    message: format!("dynamic extension authority is unavailable: {error}"),
                },
            );
        } else if let Some(dynamic) = dynamic {
            scan_dynamic_packages(
                &dynamic.packages,
                &mut extensions,
                &mut diagnostics,
                &mut discovered,
                &mut budget,
            );
        }
        for root in self
            .roots
            .iter()
            .filter(|root| root.kind == ExtensionRootKind::User)
        {
            if scan_root(
                root,
                &mut extensions,
                &mut diagnostics,
                &mut discovered,
                &mut budget,
            ) == CatalogScanControl::Stop
            {
                break;
            }
        }
        (extensions, diagnostics, discovered)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CatalogScanControl {
    Continue,
    Stop,
}

fn scan_root(
    root: &ExtensionRoot,
    extensions: &mut Vec<ExtensionDescriptor>,
    diagnostics: &mut Vec<ExtensionDiagnostic>,
    discovered: &mut BTreeMap<String, DiscoveredExtension>,
    budget: &mut CatalogBudget,
) -> CatalogScanControl {
    let canonical_root = match fs::canonicalize(&root.path) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return CatalogScanControl::Continue;
        }
        Err(_) => {
            budget.push_diagnostic(
                diagnostics,
                diagnostic(
                    root,
                    None,
                    ExtensionDiagnosticCode::SourceUnavailable,
                    "extension root is unavailable",
                ),
            );
            return CatalogScanControl::Continue;
        }
    };
    let entries = match fs::read_dir(&canonical_root) {
        Ok(entries) => entries,
        Err(_) => {
            budget.push_diagnostic(
                diagnostics,
                diagnostic(
                    root,
                    None,
                    ExtensionDiagnosticCode::SourceUnavailable,
                    "extension root cannot be read",
                ),
            );
            return CatalogScanControl::Continue;
        }
    };
    let mut packages = Vec::new();
    let mut scan_control = CatalogScanControl::Continue;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                budget.push_diagnostic(
                    diagnostics,
                    diagnostic(
                        root,
                        None,
                        ExtensionDiagnosticCode::SourceUnavailable,
                        "extension root changed while being read",
                    ),
                );
                continue;
            }
        };
        let subject = entry.file_name().to_string_lossy().into_owned();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => {
                budget.push_diagnostic(
                    diagnostics,
                    diagnostic(
                        root,
                        Some(subject),
                        ExtensionDiagnosticCode::SourceUnavailable,
                        "extension root entry cannot be inspected",
                    ),
                );
                continue;
            }
        };
        if !file_type.is_dir() && !file_type.is_symlink() {
            continue;
        }
        if let Err(limit) = budget.claim_package_candidate() {
            budget.push_diagnostic(
                diagnostics,
                catalog_limit_diagnostic(root, Some(subject), limit),
            );
            scan_control = CatalogScanControl::Stop;
            break;
        }
        packages.push((subject, entry.path()));
    }
    packages.sort_by(|left, right| left.0.cmp(&right.0));
    for (subject, package_path) in packages {
        publish_package(
            root,
            &canonical_root,
            subject,
            &package_path,
            None,
            extensions,
            diagnostics,
            discovered,
            budget,
        );
    }
    scan_control
}

fn scan_dynamic_packages(
    sources: &[DynamicExtensionPackageSource],
    extensions: &mut Vec<ExtensionDescriptor>,
    diagnostics: &mut Vec<ExtensionDiagnostic>,
    discovered: &mut BTreeMap<String, DiscoveredExtension>,
    budget: &mut CatalogBudget,
) {
    let mut sources = sources.to_vec();
    sources.sort_by(|left, right| {
        left.subject
            .cmp(&right.subject)
            .then_with(|| left.path.cmp(&right.path))
    });
    for source in sources {
        let DynamicExtensionPackageSource {
            subject,
            path,
            kind,
            normalized_manifest_json,
        } = source;
        let root_path = path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| path.clone());
        let root = ExtensionRoot {
            kind,
            path: root_path,
        };
        if let Err(limit) = budget.claim_package_candidate() {
            budget.push_diagnostic(
                diagnostics,
                catalog_limit_diagnostic(&root, Some(subject), limit),
            );
            break;
        }
        let canonical_root = match fs::canonicalize(&root.path) {
            Ok(path) => path,
            Err(_) => {
                budget.push_diagnostic(
                    diagnostics,
                    diagnostic(
                        &root,
                        Some(subject),
                        ExtensionDiagnosticCode::SourceUnavailable,
                        "dynamic extension package parent is unavailable",
                    ),
                );
                continue;
            }
        };
        publish_package(
            &root,
            &canonical_root,
            subject,
            &path,
            normalized_manifest_json.as_deref(),
            extensions,
            diagnostics,
            discovered,
            budget,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn publish_package(
    root: &ExtensionRoot,
    canonical_root: &Path,
    subject: String,
    package_path: &Path,
    normalized_manifest_json: Option<&str>,
    extensions: &mut Vec<ExtensionDescriptor>,
    diagnostics: &mut Vec<ExtensionDiagnostic>,
    discovered: &mut BTreeMap<String, DiscoveredExtension>,
    budget: &mut CatalogBudget,
) {
    match discover_package(
        root,
        canonical_root,
        package_path,
        normalized_manifest_json,
        PackageSnapshotLimits {
            max_total_bytes: budget.remaining_snapshot_bytes(),
        },
    ) {
        Ok(extension) => {
            if discovered.contains_key(&extension.descriptor.id) {
                budget.push_diagnostic(
                    diagnostics,
                    diagnostic(
                        root,
                        Some(subject),
                        ExtensionDiagnosticCode::DuplicateExtension,
                        "extension ID is already registered",
                    ),
                );
                return;
            }
            if let Err(limit) = budget.claim_published_extension(
                extension.package.total_bytes(),
                extension.descriptor.manifest_json.len(),
            ) {
                budget.push_diagnostic(
                    diagnostics,
                    catalog_limit_diagnostic(root, Some(subject), limit),
                );
                return;
            }
            extensions.push(extension.descriptor.clone());
            discovered.insert(extension.descriptor.id.clone(), extension);
        }
        Err((code, message)) => {
            budget.push_diagnostic(diagnostics, diagnostic(root, Some(subject), code, message));
        }
    }
}

fn catalog_limit_diagnostic(
    root: &ExtensionRoot,
    subject: Option<String>,
    limit: CatalogLimit,
) -> ExtensionDiagnostic {
    let message = match limit {
        CatalogLimit::PackageCandidates => "extension catalog contains too many packages",
        CatalogLimit::SnapshotBytes => "extension catalog snapshot exceeds its total byte limit",
        CatalogLimit::ManifestResponseBytes => {
            "extension catalog manifest response exceeds its total byte limit"
        }
    };
    diagnostic(
        root,
        subject,
        ExtensionDiagnosticCode::ResourceTooLarge,
        message,
    )
}

fn discover_package(
    root: &ExtensionRoot,
    canonical_root: &Path,
    package_path: &Path,
    normalized_manifest_json: Option<&str>,
    limits: PackageSnapshotLimits,
) -> Result<DiscoveredExtension, (ExtensionDiagnosticCode, &'static str)> {
    let package_metadata = fs::symlink_metadata(package_path).map_err(|_| {
        (
            ExtensionDiagnosticCode::InvalidManifest,
            "extension package cannot be inspected",
        )
    })?;
    if package_metadata.file_type().is_symlink() || !package_metadata.is_dir() {
        return Err((
            ExtensionDiagnosticCode::PathEscapesRoot,
            "extension package must be a real directory",
        ));
    }
    let package_root = fs::canonicalize(package_path).map_err(|_| {
        (
            ExtensionDiagnosticCode::InvalidManifest,
            "extension package cannot be resolved",
        )
    })?;
    if !is_within(canonical_root, &package_root) {
        return Err((
            ExtensionDiagnosticCode::PathEscapesRoot,
            "extension package escapes its source root",
        ));
    }
    let package =
        ExtensionPackageSnapshot::load(&package_root, limits).map_err(package_snapshot_error)?;
    let package_manifest_bytes = package.file("package.json").ok_or((
        ExtensionDiagnosticCode::InvalidManifest,
        "extension package.json is missing",
    ))?;
    if package_manifest_bytes.len() > MAX_MANIFEST_BYTES {
        return Err((
            ExtensionDiagnosticCode::InvalidManifest,
            "extension package.json is too large",
        ));
    }
    let manifest_text = match normalized_manifest_json {
        Some(manifest) if manifest.len() <= MAX_MANIFEST_BYTES => manifest,
        Some(_) => {
            return Err((
                ExtensionDiagnosticCode::InvalidManifest,
                "normalized extension package.json is too large",
            ));
        }
        None => std::str::from_utf8(package_manifest_bytes).map_err(|_| {
            (
                ExtensionDiagnosticCode::InvalidManifest,
                "extension package.json must be UTF-8",
            )
        })?,
    };
    let manifest = serde_json::from_str::<Value>(manifest_text).map_err(|_| {
        (
            ExtensionDiagnosticCode::InvalidManifest,
            "extension package.json is not valid JSON",
        )
    })?;
    let object = manifest.as_object().ok_or((
        ExtensionDiagnosticCode::InvalidManifest,
        "extension package.json must contain an object",
    ))?;
    let name = required_manifest_string(object, "name")?;
    let publisher = required_manifest_string(object, "publisher")?;
    let version = required_manifest_string(object, "version")?;
    let display_name = match object.get("displayName") {
        None => name.clone(),
        Some(Value::String(value))
            if !value.trim().is_empty() && value.len() <= MAX_MANIFEST_FIELD_LENGTH =>
        {
            value.clone()
        }
        Some(_) => {
            return Err((
                ExtensionDiagnosticCode::InvalidManifest,
                "extension display name is invalid",
            ));
        }
    };
    if !is_manifest_component(&name) || !is_manifest_component(&publisher) {
        return Err((
            ExtensionDiagnosticCode::InvalidManifest,
            "extension name and publisher are invalid",
        ));
    }
    let id = format!("{publisher}.{name}");
    if id.len() > MAX_EXTENSION_ID_LENGTH {
        return Err((
            ExtensionDiagnosticCode::InvalidManifest,
            "extension ID is too long",
        ));
    }
    let canonical_manifest = serde_json::to_string(&manifest).map_err(|_| {
        (
            ExtensionDiagnosticCode::InvalidManifest,
            "extension package.json cannot be serialized",
        )
    })?;
    let manifest_sha256 = format!("sha256:{:x}", Sha256::digest(canonical_manifest.as_bytes()));
    let package_sha256 = package.sha256().to_owned();
    Ok(DiscoveredExtension {
        package,
        descriptor: ExtensionDescriptor {
            id,
            name,
            publisher,
            version,
            display_name,
            source_kind: source_kind(&root.kind),
            manifest_json: canonical_manifest,
            manifest_sha256,
            package_sha256,
        },
    })
}

fn package_snapshot_error(error: PackageSnapshotError) -> (ExtensionDiagnosticCode, &'static str) {
    match error {
        PackageSnapshotError::UnsafeEntry => (
            ExtensionDiagnosticCode::PathEscapesRoot,
            "extension package contains an unsafe filesystem entry",
        ),
        PackageSnapshotError::TooManyEntries => (
            ExtensionDiagnosticCode::ResourceTooLarge,
            "extension package contains too many filesystem entries",
        ),
        PackageSnapshotError::TooManyFiles => (
            ExtensionDiagnosticCode::ResourceTooLarge,
            "extension package contains too many files",
        ),
        PackageSnapshotError::FileTooLarge => (
            ExtensionDiagnosticCode::ResourceTooLarge,
            "extension package contains a file that is too large",
        ),
        PackageSnapshotError::PackageTooLarge => (
            ExtensionDiagnosticCode::ResourceTooLarge,
            "extension package exceeds its total size limit",
        ),
        PackageSnapshotError::CatalogTooLarge => (
            ExtensionDiagnosticCode::ResourceTooLarge,
            "extension catalog snapshot exceeds its total byte limit",
        ),
        PackageSnapshotError::Unavailable => (
            ExtensionDiagnosticCode::InvalidManifest,
            "extension package changed or could not be read",
        ),
    }
}

fn required_manifest_string(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<String, (ExtensionDiagnosticCode, &'static str)> {
    let value = object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or((
            ExtensionDiagnosticCode::InvalidManifest,
            "extension manifest has a missing required string",
        ))?;
    if value.len() > MAX_MANIFEST_FIELD_LENGTH {
        return Err((
            ExtensionDiagnosticCode::InvalidManifest,
            "extension manifest field is too long",
        ));
    }
    Ok(value.to_string())
}

fn is_manifest_component(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn source_kind(kind: &ExtensionRootKind) -> ExtensionSourceKind {
    match kind {
        ExtensionRootKind::BuiltIn => ExtensionSourceKind::BuiltIn,
        ExtensionRootKind::Plugin => ExtensionSourceKind::Plugin,
        ExtensionRootKind::Marketplace => ExtensionSourceKind::Marketplace,
        ExtensionRootKind::User => ExtensionSourceKind::User,
    }
}
