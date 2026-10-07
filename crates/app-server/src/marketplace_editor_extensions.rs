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

use crate::server::extension_host_runtime::source::ActivationPlan;
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
    for source in manager
        .local_capability_sources(CapabilityKind::EditorExtension)
        .map_err(|error| error.to_string())?
    {
        let Ok(Some(entrypoint)) = javascript_entrypoint(&source) else {
            continue;
        };
        // Invalid declarations belong to this package's failure state, never the whole fleet.
        let (activation, activation_failure, activation_events) =
            match javascript_activation_plan(&source) {
                Ok(plan) => {
                    let events = plan.events.clone();
                    (Some(plan), None, events)
                }
                Err(message) => (None, Some(message), Vec::new()),
            };
        let extension_id = format!("marketplace:{}:vscode", source.package().id);
        let capabilities = vec![
            ExtensionCapability::Command,
            ExtensionCapability::LanguageProvider,
            ExtensionCapability::StatusBar,
        ];
        let binding = MarketplaceEditorExtensionBinding {
            package: source.package().clone(),
            capability: source.capability().clone(),
            extension_id: extension_id.clone(),
            requested_capabilities: capabilities.clone(),
        };
        let current = std::env::current_exe().map_err(|error| error.to_string())?;
        let executable = current
            .parent()
            .ok_or("missing product executable directory")?
            .join(format!(
                "ash-js-extension-host{}",
                std::env::consts::EXE_SUFFIX
            ));
        let root = source
            .host_path()
            .to_str()
            .ok_or("invalid extension source path")?
            .to_string();
        let command = ExtensionLaunchCommand::javascript(
            executable,
            vec![
                "--extension-id".into(),
                extension_id.clone(),
                "--package".into(),
                root,
                "--entry".into(),
                entrypoint.clone(),
                "--api".into(),
                "vscode".into(),
            ],
            source.host_path(),
        )
        .map_err(|error| error.to_string())?;
        result.push(EditorExtensionDeployment {
            activation,
            activation_failure,
            id: extension_id.clone(),
            version: source.package().version.clone(),
            package_digest: source.package().digest.clone(),
            command,
            workspace_read:
                crate::server::extension_host_runtime::source::WorkspaceReadAccess::Denied,
            params: ActivateParams {
                extension_id,
                package: PackageBinding {
                    package_id: format!("{}@{}", source.package().id, source.package().version),
                    package_digest: source.package().digest.clone(),
                    entrypoint,
                },
                runtime_api_version: 1,
                activation_events,
                capabilities,
            },
            authority: Arc::new(MarketplaceExecutableAuthority {
                manager: Arc::clone(manager),
                admission: Arc::clone(admission),
                binding,
                source,
            }),
        });
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
        source: source.clone(),
    });
    Ok(EditorExtensionDeployment {
        activation: None,
        activation_failure: None,
        id: extension_id.clone(),
        version: source.package().version.clone(),
        package_digest: source.package().digest.clone(),
        // Executable admission currently carries no directory-read ceiling.
        workspace_read: crate::server::extension_host_runtime::source::WorkspaceReadAccess::Denied,
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
    source: LocalCapabilitySource,
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
                                capability.kind == self.source.kind()
                                    && capability.reference == self.binding.capability
                            })
                    })
                })
    }

    fn acquire(&self) -> Option<Box<dyn ActivationLease>> {
        let admission = self.admission.acquire(&self.binding)?;
        if self.source.kind() == CapabilityKind::EditorExtension {
            let lease = self.manager.acquire_local_source(&self.source).ok()?;
            return Some(Box::new(MarketplaceExecutableLease {
                manager: Arc::clone(&self.manager),
                manager_lease_id: lease.id,
                _admission: admission,
            }));
        }
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

/// Reads declarations separately from the process registrations published after activation.
fn javascript_activation_plan(source: &LocalCapabilitySource) -> Result<ActivationPlan, String> {
    let bytes = std::fs::read(source.host_path().join("package.json"))
        .map_err(|error| error.to_string())?;
    let manifest: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    activation_plan(&manifest)
}

fn activation_plan(manifest: &serde_json::Value) -> Result<ActivationPlan, String> {
    let mut events: BTreeSet<String> = match manifest.get("activationEvents") {
        None => BTreeSet::new(),
        Some(value) => serde_json::from_value::<Vec<String>>(value.clone())
            .map_err(|_| "invalid activation events")?
            .into_iter()
            .collect(),
    };
    let mut commands = Vec::new();
    if let Some(entries) = manifest.pointer("/contributes/commands") {
        for entry in entries.as_array().ok_or("invalid command contributions")? {
            let command = entry
                .get("command")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty() && value.len() <= 256)
                .ok_or("invalid command contribution")?;
            let title = entry
                .get("title")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty() && value.len() <= 512)
                .ok_or("invalid command title")?;
            events.insert(format!("onCommand:{command}"));
            commands.push((command.to_owned(), title.to_owned()));
        }
    }
    if let Some(entries) = manifest.pointer("/contributes/languages") {
        for entry in entries.as_array().ok_or("invalid language contributions")? {
            let id = entry
                .get("id")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty() && value.len() <= 128)
                .ok_or("invalid language contribution")?;
            events.insert(format!("onLanguage:{id}"));
        }
    }
    if events.len() > MAXIMUM_ACTIVATION_EVENTS
        || events
            .iter()
            .any(|event| event.is_empty() || event.len() > MAXIMUM_ACTIVATION_EVENT_BYTES)
        || commands.len() > 2048
        || commands
            .iter()
            .map(|(id, _)| id)
            .collect::<BTreeSet<_>>()
            .len()
            != commands.len()
    {
        return Err("activation declaration quota or identity is invalid".into());
    }
    Ok(ActivationPlan {
        events: events.into_iter().collect(),
        commands,
    })
}

pub(crate) fn javascript_entrypoint(
    source: &LocalCapabilitySource,
) -> Result<Option<String>, String> {
    let path = source.host_path().join("package.json");
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| "missing extension manifest")?;
    if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
        return Err("invalid extension manifest".into());
    }
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).map_err(|_| "missing extension manifest")?)
            .map_err(|_| "invalid extension manifest")?;
    let entry = if manifest.get("browser").is_some() {
        manifest.get("browser")
    } else {
        manifest.get("main")
    };
    let Some(entry) = entry else {
        return Ok(None);
    };
    let entry = entry
        .as_str()
        .ok_or("invalid extension entry")?
        .strip_prefix("./")
        .unwrap_or(entry.as_str().ok_or("invalid extension entry")?);
    let path = std::path::Path::new(entry);
    if entry.is_empty()
        || path.is_absolute()
        || !path
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_)))
    {
        return Err("invalid extension entry".into());
    }
    let entry = if path.extension().is_none() {
        format!("{entry}.js")
    } else {
        entry.into()
    };
    if !matches!(
        std::path::Path::new(&entry)
            .extension()
            .and_then(|ext| ext.to_str()),
        Some("js" | "mjs")
    ) {
        return Err("unsupported extension entry".into());
    }
    let metadata = std::fs::symlink_metadata(source.host_path().join(&entry))
        .map_err(|_| "missing extension entry")?;
    if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
        return Err("invalid extension entry".into());
    }
    Ok(Some(entry))
}

pub(crate) struct ProfileEditorExtensionAdmission(
    pub(crate) Arc<ash_core_plugins::EditorExtensionPolicy>,
);
struct ProfileAdmissionLease {
    _policy: Arc<ash_core_plugins::EditorExtensionPolicy>,
}
impl MarketplaceEditorExtensionAdmissionLease for ProfileAdmissionLease {}
impl MarketplaceEditorExtensionAdmission for ProfileEditorExtensionAdmission {
    fn generation(&self) -> u64 {
        self.0.generation()
    }
    fn subscribe(&self) -> Option<std::sync::mpsc::Receiver<u64>> {
        Some(self.0.subscribe())
    }
    fn authorizes(&self, binding: &MarketplaceEditorExtensionBinding) -> bool {
        let state = self.0.snapshot(binding.package(), binding.capability());
        state.enabled && state.granted
    }
    fn acquire(
        &self,
        binding: &MarketplaceEditorExtensionBinding,
    ) -> Option<Box<dyn MarketplaceEditorExtensionAdmissionLease>> {
        self.authorizes(binding).then(|| {
            Box::new(ProfileAdmissionLease {
                _policy: Arc::clone(&self.0),
            }) as Box<dyn MarketplaceEditorExtensionAdmissionLease>
        })
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
    StatusBar,
    Command,
    LanguageProvider,
    DebugAdapter,
    TaskProvider,
    TestProfileProvider,
    DataChannel,
    LinkPresentationProvider,
    ExternalUriOpener,
}

impl ManifestCapability {
    fn host(self) -> ExtensionCapability {
        match self {
            Self::StatusBar => ExtensionCapability::StatusBar,
            Self::Command => ExtensionCapability::Command,
            Self::LanguageProvider => ExtensionCapability::LanguageProvider,
            Self::DebugAdapter => ExtensionCapability::DebugAdapter,
            Self::TaskProvider => ExtensionCapability::TaskProvider,
            Self::TestProfileProvider => ExtensionCapability::TestProfileProvider,
            Self::DataChannel => ExtensionCapability::DataChannel,
            Self::LinkPresentationProvider => ExtensionCapability::LinkPresentationProvider,
            Self::ExternalUriOpener => ExtensionCapability::ExternalUriOpener,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::StatusBar => "statusBar",
            Self::Command => "command",
            Self::LanguageProvider => "languageProvider",
            Self::DebugAdapter => "debugAdapter",
            Self::TaskProvider => "taskProvider",
            Self::TestProfileProvider => "testProfileProvider",
            Self::DataChannel => "dataChannel",
            Self::LinkPresentationProvider => "linkPresentationProvider",
            Self::ExternalUriOpener => "externalUriOpener",
        }
    }
}

#[cfg(test)]
#[path = "marketplace_editor_extensions_tests.rs"]
mod tests;
