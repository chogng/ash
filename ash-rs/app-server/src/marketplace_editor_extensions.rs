use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::sync::Arc;

use ash_core_plugins::AcquireCapabilityRequest;
use ash_core_plugins::ActivationSpec;
use ash_core_plugins::CapabilityKind;
use ash_core_plugins::CapabilityRef;
use ash_core_plugins::InstallationState;
use ash_core_plugins::ListInstalledRequest;
use ash_core_plugins::LocalCapabilitySource;
use ash_core_plugins::PackageRef;
use ash_core_plugins::PluginPackageService;
use ash_core_plugins::PluginsManager;
use ash_core_plugins::ReleaseCapabilityRequest;
use ash_editor_extension_host::ActivateParams;
use ash_editor_extension_host::ActivationAuthority;
use ash_editor_extension_host::ActivationLease;
use ash_editor_extension_host::ExtensionCapability;
use ash_editor_extension_host::ExtensionLaunchCommand;
use ash_editor_extension_host::PackageBinding;
use serde::Deserialize;

use crate::server::extension_host_runtime::source::EditorExtensionDeployment;

const PRODUCT_MANIFEST_PATH: &str = "ash/editor-extensions.json";
const MAXIMUM_MANIFEST_BYTES: u64 = 64 * 1024;
const MAXIMUM_EXTENSIONS: usize = 128;
const MAXIMUM_ACTIVATION_EVENTS: usize = 128;
const MAXIMUM_ACTIVATION_EVENT_BYTES: usize = 256;
const MAXIMUM_CAPABILITIES: usize = 16;

/// Exact Marketplace artifact and executable capability presented to product admission policy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketplaceEditorExtensionBinding {
    package: PackageRef,
    capability: CapabilityRef,
    extension_id: String,
    requested_capabilities: Vec<ExtensionCapability>,
}

impl MarketplaceEditorExtensionBinding {
    pub fn package(&self) -> &PackageRef {
        &self.package
    }

    pub fn capability(&self) -> &CapabilityRef {
        &self.capability
    }

    pub fn extension_id(&self) -> &str {
        &self.extension_id
    }

    pub fn requested_capabilities(&self) -> &[ExtensionCapability] {
        &self.requested_capabilities
    }
}

/// Held product admission lease for one Marketplace Editor Extension activation or invocation.
///
/// Implementations keep enable/grant revocation drain semantics active until this value is dropped.
pub trait MarketplaceEditorExtensionAdmissionLease: Send {}

/// Product-local enable and grant authority for Marketplace executable Editor Extensions.
///
/// Installing a package never implies execution permission. Implementations are expected to bind
/// grants to the exact package digest, executable capability, and requested capability ceiling in
/// `binding`. `acquire` must fail after revocation and return a lease that drains admitted work.
pub trait MarketplaceEditorExtensionAdmission: Send + Sync {
    /// Returns the current product-local enable/grant generation.
    ///
    /// Implementations must advance this value whenever any binding's authorization can change.
    fn generation(&self) -> u64;

    /// Subscribes to future generation changes when this authority is mutable.
    ///
    /// Immutable authorities may return `None`. A mutable implementation must publish after the
    /// corresponding policy commit so the Host fleet can revoke old processes before rebuilding.
    fn subscribe(&self) -> Option<std::sync::mpsc::Receiver<u64>> {
        None
    }

    fn authorizes(&self, binding: &MarketplaceEditorExtensionBinding) -> bool;

    fn acquire(
        &self,
        binding: &MarketplaceEditorExtensionBinding,
    ) -> Option<Box<dyn MarketplaceEditorExtensionAdmissionLease>>;
}

pub(crate) fn deployments(
    manager: &Arc<PluginsManager>,
    admission: &Arc<dyn MarketplaceEditorExtensionAdmission>,
) -> Result<Vec<EditorExtensionDeployment>, String> {
    let executable_sources = manager
        .local_capability_sources(CapabilityKind::Executable)
        .map_err(|error| error.to_string())?;
    let mut manifests = BTreeMap::new();
    for source in &executable_sources {
        let digest = source.package().digest.clone();
        if let std::collections::btree_map::Entry::Vacant(entry) = manifests.entry(digest) {
            entry.insert(read_product_manifest(source.package_root())?);
        }
    }
    let mut result = Vec::new();
    let mut identities = BTreeSet::new();
    for source in executable_sources {
        let Some(manifest) = manifests
            .get(&source.package().digest)
            .and_then(Option::as_ref)
        else {
            continue;
        };
        for declaration in manifest
            .editor_extensions
            .iter()
            .filter(|declaration| declaration.executable == source.id())
        {
            let deployment = deployment(manager, admission, &source, declaration)?;
            if !identities.insert(deployment.id.clone()) {
                return Err("Marketplace Editor Extension identity is duplicated".into());
            }
            result.push(deployment);
        }
    }
    result.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(result)
}

fn deployment(
    manager: &Arc<PluginsManager>,
    admission: &Arc<dyn MarketplaceEditorExtensionAdmission>,
    source: &LocalCapabilitySource,
    declaration: &MarketplaceEditorExtensionDeclaration,
) -> Result<EditorExtensionDeployment, String> {
    validate_declaration(declaration)?;
    if source.runtime() != Some("direct") {
        return Err("Marketplace Editor Extension must use a direct executable runtime".into());
    }
    validate_executable(source)?;
    let extension_id = format!(
        "marketplace:{}:editor-extension:{}",
        source.package().id,
        declaration.id
    );
    if extension_id.len() > 256 {
        return Err("Marketplace Editor Extension identity is too large".into());
    }
    let capabilities = declaration
        .capabilities
        .iter()
        .copied()
        .map(ManifestCapability::host)
        .collect::<Vec<_>>();
    let binding = MarketplaceEditorExtensionBinding {
        package: source.package().clone(),
        capability: source.capability().clone(),
        extension_id: extension_id.clone(),
        requested_capabilities: capabilities.clone(),
    };
    let authority: Arc<dyn ActivationAuthority> = Arc::new(MarketplaceExecutableAuthority {
        manager: Arc::clone(manager),
        admission: Arc::clone(admission),
        binding,
    });
    Ok(EditorExtensionDeployment {
        id: extension_id.clone(),
        version: source.package().version.clone(),
        package_digest: source.package().digest.clone(),
        command: ExtensionLaunchCommand::new(
            source.host_path(),
            std::iter::empty::<String>(),
            source.package_root(),
            BTreeMap::new(),
        )
        .map_err(|error| error.to_string())?,
        params: ActivateParams {
            extension_id,
            package: PackageBinding {
                package_id: format!("{}@{}", source.package().id, source.package().version),
                package_digest: source.package().digest.clone(),
                entrypoint: source.relative_path().to_string(),
            },
            runtime_api_version: declaration.runtime_api_version,
            activation_events: declaration
                .activation_events
                .iter()
                .map(ManifestActivationEvent::host)
                .collect(),
            capabilities,
        },
        authority,
    })
}

fn read_product_manifest(
    package_root: &std::path::Path,
) -> Result<Option<MarketplaceEditorExtensionsManifest>, String> {
    let path = package_root.join(PRODUCT_MANIFEST_PATH);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Marketplace Editor Extension adapter is unavailable".into()),
    };
    if !metadata.is_file() || metadata.len() > MAXIMUM_MANIFEST_BYTES {
        return Err("Marketplace Editor Extension adapter exceeds its file contract".into());
    }
    let bytes = std::fs::read(path)
        .map_err(|_| "Marketplace Editor Extension adapter is unavailable".to_string())?;
    let manifest: MarketplaceEditorExtensionsManifest = serde_json::from_slice(&bytes)
        .map_err(|_| "Marketplace Editor Extension adapter is invalid".to_string())?;
    if manifest.schema_version != 1
        || manifest.editor_extensions.is_empty()
        || manifest.editor_extensions.len() > MAXIMUM_EXTENSIONS
    {
        return Err("Marketplace Editor Extension adapter version is unsupported".into());
    }
    let mut ids = BTreeSet::new();
    let mut executables = BTreeSet::new();
    for declaration in &manifest.editor_extensions {
        validate_declaration(declaration)?;
        if !ids.insert(&declaration.id) || !executables.insert(&declaration.executable) {
            return Err("Marketplace Editor Extension adapter contains duplicate bindings".into());
        }
    }
    Ok(Some(manifest))
}

fn validate_declaration(declaration: &MarketplaceEditorExtensionDeclaration) -> Result<(), String> {
    if !valid_local_id(&declaration.id)
        || !valid_local_id(&declaration.executable)
        || declaration.runtime_api_version != 1
        || declaration.activation_events.is_empty()
        || declaration.activation_events.len() > MAXIMUM_ACTIVATION_EVENTS
        || declaration.capabilities.is_empty()
        || declaration.capabilities.len() > MAXIMUM_CAPABILITIES
    {
        return Err("Marketplace Editor Extension declaration is invalid".into());
    }
    let capabilities = declaration
        .capabilities
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    let activation_events = declaration
        .activation_events
        .iter()
        .map(ManifestActivationEvent::host)
        .collect::<BTreeSet<_>>();
    if activation_events.len() != declaration.activation_events.len()
        || activation_events.iter().any(|event| {
            event.len() > MAXIMUM_ACTIVATION_EVENT_BYTES || event.chars().any(char::is_control)
        })
        || declaration
            .activation_events
            .iter()
            .any(|event| !event.has_valid_selector())
        || capabilities.len() != declaration.capabilities.len()
        || declaration
            .activation_events
            .iter()
            .filter_map(ManifestActivationEvent::required_capability)
            .any(|capability| !capabilities.contains(&capability))
    {
        return Err("Marketplace Editor Extension capability ceiling is inconsistent".into());
    }
    Ok(())
}

fn validate_executable(source: &LocalCapabilitySource) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(source.host_path())
        .map_err(|_| "Marketplace Editor Extension executable is unavailable".to_string())?;
    if !metadata.is_file() {
        return Err("Marketplace Editor Extension executable is not a regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err("Marketplace Editor Extension executable is not executable".into());
        }
    }
    Ok(())
}

fn valid_local_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && !value.starts_with('-')
        && !value.ends_with('-')
        && !value.contains("--")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

struct MarketplaceExecutableAuthority {
    manager: Arc<PluginsManager>,
    admission: Arc<dyn MarketplaceEditorExtensionAdmission>,
    binding: MarketplaceEditorExtensionBinding,
}

impl ActivationAuthority for MarketplaceExecutableAuthority {
    fn authorizes(&self) -> bool {
        self.admission.authorizes(&self.binding)
            && self
                .manager
                .list_installed(ListInstalledRequest {})
                .is_ok_and(|installed| {
                    installed.iter().any(|package| {
                        package.state == InstallationState::Installed
                            && package.package == self.binding.package
                            && package.capabilities.iter().any(|capability| {
                                capability.kind == CapabilityKind::Executable
                                    && capability.reference == self.binding.capability
                            })
                    })
                })
    }

    fn acquire(&self) -> Option<Box<dyn ActivationLease>> {
        let admission = self.admission.acquire(&self.binding)?;
        let acquired = self
            .manager
            .acquire_capability(AcquireCapabilityRequest {
                capability: self.binding.capability.clone(),
            })
            .ok()?;
        if !matches!(acquired.spec, ActivationSpec::Executable(_)) {
            let _ = self.manager.release_capability(ReleaseCapabilityRequest {
                lease_id: acquired.lease.id,
            });
            return None;
        }
        Some(Box::new(MarketplaceExecutableLease {
            manager: Arc::clone(&self.manager),
            manager_lease_id: acquired.lease.id,
            _admission: admission,
        }))
    }
}

struct MarketplaceExecutableLease {
    manager: Arc<PluginsManager>,
    manager_lease_id: String,
    _admission: Box<dyn MarketplaceEditorExtensionAdmissionLease>,
}

impl ActivationLease for MarketplaceExecutableLease {}

impl Drop for MarketplaceExecutableLease {
    fn drop(&mut self) {
        let _ = self.manager.release_capability(ReleaseCapabilityRequest {
            lease_id: self.manager_lease_id.clone(),
        });
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarketplaceEditorExtensionsManifest {
    schema_version: u32,
    editor_extensions: Vec<MarketplaceEditorExtensionDeclaration>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarketplaceEditorExtensionDeclaration {
    id: String,
    executable: String,
    runtime_api_version: u16,
    activation_events: Vec<ManifestActivationEvent>,
    capabilities: Vec<ManifestCapability>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ManifestActivationEvent {
    Startup,
    OnCommand { id: String },
    OnLanguage { id: String },
    OnDemand { capability: ManifestCapability },
    OnDebugType { debug_type: String },
    OnTaskType { task_type: String },
    OnTestProfile { profile_id: String },
}

impl ManifestActivationEvent {
    fn host(&self) -> String {
        match self {
            Self::Startup => "startup".into(),
            Self::OnCommand { id } => format!("onCommand:{id}"),
            Self::OnLanguage { id } => format!("onLanguage:{id}"),
            Self::OnDemand { capability } => format!("onDemand:{}", capability.name()),
            Self::OnDebugType { debug_type } => format!("onDebugType:{debug_type}"),
            Self::OnTaskType { task_type } => format!("onTaskType:{task_type}"),
            Self::OnTestProfile { profile_id } => format!("onTestProfile:{profile_id}"),
        }
    }

    fn required_capability(&self) -> Option<ManifestCapability> {
        match self {
            Self::Startup => None,
            Self::OnCommand { .. } => Some(ManifestCapability::Command),
            Self::OnLanguage { .. } => Some(ManifestCapability::LanguageProvider),
            Self::OnDemand { capability } => Some(*capability),
            Self::OnDebugType { .. } => Some(ManifestCapability::DebugAdapter),
            Self::OnTaskType { .. } => Some(ManifestCapability::TaskProvider),
            Self::OnTestProfile { .. } => Some(ManifestCapability::TestProfileProvider),
        }
    }

    fn has_valid_selector(&self) -> bool {
        match self {
            Self::Startup | Self::OnDemand { .. } => true,
            Self::OnCommand { id } | Self::OnLanguage { id } => valid_event_selector(id),
            Self::OnDebugType { debug_type } => valid_event_selector(debug_type),
            Self::OnTaskType { task_type } => valid_event_selector(task_type),
            Self::OnTestProfile { profile_id } => valid_event_selector(profile_id),
        }
    }
}

fn valid_event_selector(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAXIMUM_ACTIVATION_EVENT_BYTES
        && !value.chars().any(char::is_whitespace)
        && !value.chars().any(char::is_control)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "camelCase")]
enum ManifestCapability {
    Command,
    LanguageProvider,
    DebugAdapter,
    TaskProvider,
    TestProfileProvider,
}

impl ManifestCapability {
    fn host(self) -> ExtensionCapability {
        match self {
            Self::Command => ExtensionCapability::Command,
            Self::LanguageProvider => ExtensionCapability::LanguageProvider,
            Self::DebugAdapter => ExtensionCapability::DebugAdapter,
            Self::TaskProvider => ExtensionCapability::TaskProvider,
            Self::TestProfileProvider => ExtensionCapability::TestProfileProvider,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::LanguageProvider => "languageProvider",
            Self::DebugAdapter => "debugAdapter",
            Self::TaskProvider => "taskProvider",
            Self::TestProfileProvider => "testProfileProvider",
        }
    }
}

#[cfg(test)]
#[path = "marketplace_editor_extensions_tests.rs"]
mod tests;
