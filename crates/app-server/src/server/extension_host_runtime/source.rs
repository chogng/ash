use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use ash_core_plugins::PluginActivationAuthority;
use ash_core_plugins::PluginInvocationFence;
use ash_core_plugins::PluginInvocationLease;
use ash_core_plugins::PluginsManager;
use ash_editor_extension_host::ActivateParams;
use ash_editor_extension_host::ActivationAuthority;
use ash_editor_extension_host::ActivationLease;
use ash_editor_extension_host::ExtensionCapability;
use ash_editor_extension_host::ExtensionHostError;
use ash_editor_extension_host::ExtensionLaunchCommand;
use ash_editor_extension_host::PackageBinding;
use ash_plugin::EditorExtensionActivationEvent;
use ash_plugin::EditorExtensionCapability;

use super::ExtensionHostRuntimeError;
use crate::MarketplaceEditorExtensionAdmission;
use crate::marketplace_editor_extensions;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct EditorExtensionSourceRevision {
    pub(crate) plugin: u64,
    pub(crate) marketplace: u64,
    pub(crate) marketplace_admission: u64,
}

pub(crate) struct EditorExtensionSourceSnapshot {
    pub(crate) revision: EditorExtensionSourceRevision,
    pub(crate) deployments: Vec<EditorExtensionDeployment>,
}

/// Package permission ceiling, independent of the workspace user's filesystem grant.
#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum WorkspaceReadAccess {
    Denied,
    Read,
}

#[derive(Clone, Copy, Default, Eq, PartialEq)]
pub(crate) enum BuiltInEditorExtensions {
    #[default]
    Omitted,
    Product,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum EditorExtensionScope {
    Workspace,
    Profile,
    Product,
}

#[derive(Clone)]
pub(crate) struct EditorExtensionDeployment {
    pub(crate) scope: EditorExtensionScope,
    pub(crate) id: String,
    pub(crate) version: String,
    pub(crate) package_digest: String,
    pub(crate) command: ExtensionLaunchCommand,
    pub(crate) workspace_read: WorkspaceReadAccess,
    pub(crate) params: ActivateParams,
    pub(crate) authority: Arc<dyn ActivationAuthority>,
    pub(crate) activation: Option<ActivationPlan>,
    pub(crate) activation_failure: Option<String>,
}

pub(super) fn built_in_deployments(
    selection: BuiltInEditorExtensions,
) -> Result<Vec<EditorExtensionDeployment>, ExtensionHostRuntimeError> {
    if selection == BuiltInEditorExtensions::Omitted {
        return Ok(Vec::new());
    }
    let executable = std::env::current_exe().map_err(|_| ExtensionHostRuntimeError::Internal)?;
    let directory = executable
        .parent()
        .ok_or(ExtensionHostRuntimeError::Internal)?;
    product_ssh_deployment(directory).map(|deployment| vec![deployment])
}

fn product_ssh_deployment(
    directory: &Path,
) -> Result<EditorExtensionDeployment, ExtensionHostRuntimeError> {
    let source = include_str!("../../../../../extensions/remote-ssh/src/extension.js");
    let manifest = include_str!("../../../../../extensions/remote-ssh/package.json");
    let sdk = include_str!("../../../../../extension-sdk/index.js");
    let digest = format!(
        "sha256:{:x}",
        Sha256::digest(format!("{manifest}\0{source}\0{sdk}"))
    );
    let id = "ash.remote-ssh".to_string();
    Ok(EditorExtensionDeployment {
        scope: EditorExtensionScope::Product,
        id: id.clone(),
        version: "1.0.0".into(),
        package_digest: digest.clone(),
        command: ExtensionLaunchCommand::product_javascript(
            directory.join(format!(
                "ash-js-extension-host{}",
                std::env::consts::EXE_SUFFIX
            )),
            "remote-ssh",
            directory,
        )
        .map_err(ExtensionHostRuntimeError::Host)?,
        workspace_read: WorkspaceReadAccess::Denied,
        params: ActivateParams {
            extension_id: id,
            package: PackageBinding {
                package_id: "ash.remote-ssh@1.0.0".into(),
                package_digest: digest,
                entrypoint: "src/extension.js".into(),
            },
            runtime_api_version: 1,
            activation_events: vec!["startup".into()],
            capabilities: vec![
                ExtensionCapability::RemoteAuthorityResolver,
                ExtensionCapability::ProductRemoteAuthorityResolver,
            ],
        },
        authority: Arc::new(ProductAuthority),
        activation: None,
        activation_failure: None,
    })
}

// This authority admits only the module compiled into the product executable. Fleet retirement
// owns process cancellation; a release update replaces the bytes on the next backend start.
struct ProductAuthority;
struct ProductLease;
impl ActivationLease for ProductLease {}
impl ActivationAuthority for ProductAuthority {
    fn authorizes(&self) -> bool {
        true
    }
    fn acquire(&self) -> Option<Box<dyn ActivationLease>> {
        Some(Box::new(ProductLease))
    }
}

/// Manifest facts are distinct from process-owned registrations. Waiting never holds a process lease.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ActivationPlan {
    pub(crate) events: Vec<String>,
    pub(crate) commands: Vec<(String, String)>,
}

#[derive(Clone, Debug)]
pub(in crate::server) enum ActivationEvent {
    Command(String),
    Language(String),
    StartupFinished,
    ResolveAuthority(String),
}

impl ActivationPlan {
    pub(super) fn matches(&self, event: &ActivationEvent) -> bool {
        match event {
            ActivationEvent::Command(command) => self
                .events
                .iter()
                .any(|event| event == &format!("onCommand:{command}")),
            ActivationEvent::Language(language) => self
                .events
                .iter()
                .any(|event| event == "onLanguage" || event == &format!("onLanguage:{language}")),
            ActivationEvent::ResolveAuthority(prefix) => self.events.iter().any(|event| {
                event == "onDemand:remoteAuthorityResolver"
                    || event == &format!("onResolveRemoteAuthority:{prefix}")
            }),
            ActivationEvent::StartupFinished => {
                self.events.iter().any(|event| event == "onStartupFinished")
            }
        }
    }
}

pub(super) fn plugin_deployments(
    authority: &PluginActivationAuthority,
) -> Result<EditorExtensionSourceSnapshot, ExtensionHostRuntimeError> {
    let snapshot = authority.snapshot();
    let activation = snapshot.activation();
    let mut deployments = Vec::new();
    for package in activation.packages() {
        let fence = authority
            .invocation_fence(package)
            .ok_or(ExtensionHostRuntimeError::Internal)?;
        for contribution in &package.manifest().contributions.editor_extensions {
            let id = stable_extension_id(package.manifest().id.as_str(), contribution.id.as_str());
            let entry = package
                .resolve_file(&contribution.entrypoint)
                .map_err(|_| ExtensionHostRuntimeError::Host(ExtensionHostError::SpawnFailed))?;
            let (executable, arguments) = match contribution.runtime {
                ash_plugin::EditorExtensionRuntime::HostRpc => (entry, Vec::new()),
                ash_plugin::EditorExtensionRuntime::JavaScript => {
                    let current = std::env::current_exe().map_err(|_| {
                        ExtensionHostRuntimeError::Host(ExtensionHostError::SpawnFailed)
                    })?;
                    let directory = current
                        .parent()
                        .ok_or(ExtensionHostRuntimeError::Internal)?;
                    let executable = directory.join(format!(
                        "ash-js-extension-host{}",
                        std::env::consts::EXE_SUFFIX
                    ));
                    let root = package
                        .package_root()
                        .to_str()
                        .ok_or(ExtensionHostRuntimeError::Internal)?
                        .to_string();
                    (
                        executable,
                        vec![
                            "--extension-id".into(),
                            id.clone(),
                            "--package".into(),
                            root,
                            "--entry".into(),
                            contribution.entrypoint.as_str().into(),
                        ],
                    )
                }
            };
            let command = match contribution.runtime {
                ash_plugin::EditorExtensionRuntime::HostRpc => ExtensionLaunchCommand::new(
                    executable,
                    arguments,
                    package.package_root(),
                    BTreeMap::new(),
                ),
                ash_plugin::EditorExtensionRuntime::JavaScript => {
                    ExtensionLaunchCommand::javascript(
                        executable,
                        arguments,
                        package.package_root(),
                    )
                }
            }
            .map_err(ExtensionHostRuntimeError::Host)?;
            deployments.push(EditorExtensionDeployment {
                scope: if contribution.runtime == ash_plugin::EditorExtensionRuntime::JavaScript
                    && contribution
                        .capabilities
                        .contains(&EditorExtensionCapability::RemoteAuthorityResolver)
                {
                    EditorExtensionScope::Profile
                } else {
                    EditorExtensionScope::Workspace
                },
                id: id.clone(),
                version: package.manifest().version.to_string(),
                package_digest: package.package_digest().as_str().to_string(),
                command,
                workspace_read: if package.manifest().permissions.iter().any(|permission| {
                    matches!(
                        permission,
                        ash_plugin::Permission::Directory {
                            access: ash_plugin::DirectoryAccess::Read
                        }
                    )
                }) {
                    WorkspaceReadAccess::Read
                } else {
                    WorkspaceReadAccess::Denied
                },
                params: ActivateParams {
                    extension_id: id,
                    package: PackageBinding {
                        package_id: format!(
                            "{}@{}",
                            package.manifest().id,
                            package.manifest().version
                        ),
                        package_digest: package.package_digest().as_str().to_string(),
                        entrypoint: contribution.entrypoint.as_str().to_string(),
                    },
                    runtime_api_version: contribution.runtime_api_version.as_u16(),
                    activation_events: contribution
                        .activation_events
                        .iter()
                        .map(activation_event)
                        .collect(),
                    capabilities: contribution
                        .capabilities
                        .iter()
                        .copied()
                        .map(extension_capability)
                        .collect(),
                },
                activation: None,
                activation_failure: None,
                authority: Arc::new(PluginPackageAuthority {
                    fence: fence.clone(),
                }),
            });
        }
    }
    deployments.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(EditorExtensionSourceSnapshot {
        revision: EditorExtensionSourceRevision {
            plugin: activation.generation(),
            marketplace: 0,
            marketplace_admission: 0,
        },
        deployments,
    })
}

pub(super) fn combined_deployments(
    plugin: Option<&PluginActivationAuthority>,
    marketplace: Option<&Arc<PluginsManager>>,
    marketplace_admission: Option<&Arc<dyn MarketplaceEditorExtensionAdmission>>,
) -> Result<EditorExtensionSourceSnapshot, ExtensionHostRuntimeError> {
    let mut snapshot = match plugin {
        Some(plugin) => plugin_deployments(plugin)?,
        None => EditorExtensionSourceSnapshot {
            revision: EditorExtensionSourceRevision::default(),
            deployments: Vec::new(),
        },
    };
    if let (Some(manager), Some(admission)) = (marketplace, marketplace_admission) {
        snapshot.revision.marketplace = manager
            .generation()
            .map_err(|_| ExtensionHostRuntimeError::Internal)?;
        snapshot.revision.marketplace_admission = admission.generation();
        snapshot.deployments.extend(
            marketplace_editor_extensions::deployments(manager, admission)
                .map_err(|_| ExtensionHostRuntimeError::Internal)?,
        );
    }
    snapshot
        .deployments
        .sort_by(|left, right| left.id.cmp(&right.id));
    if snapshot
        .deployments
        .windows(2)
        .any(|pair| pair[0].id == pair[1].id)
    {
        return Err(ExtensionHostRuntimeError::Internal);
    }
    Ok(snapshot)
}

pub(super) fn stable_extension_id(plugin_id: &str, contribution_id: &str) -> String {
    format!("{plugin_id}:{contribution_id}")
}

fn activation_event(event: &EditorExtensionActivationEvent) -> String {
    match event {
        EditorExtensionActivationEvent::Startup => "startup".into(),
        EditorExtensionActivationEvent::OnCommand { id } => format!("onCommand:{id}"),
        EditorExtensionActivationEvent::OnLanguage { id } => format!("onLanguage:{id}"),
        EditorExtensionActivationEvent::OnDemand { capability } => {
            format!("onDemand:{}", capability_name(*capability))
        }
        EditorExtensionActivationEvent::OnDebugType { debug_type } => {
            format!("onDebugType:{debug_type}")
        }
        EditorExtensionActivationEvent::OnTaskType { task_type } => {
            format!("onTaskType:{task_type}")
        }
        EditorExtensionActivationEvent::OnTestProfile { profile_id } => {
            format!("onTestProfile:{profile_id}")
        }
    }
}

fn extension_capability(capability: EditorExtensionCapability) -> ExtensionCapability {
    match capability {
        EditorExtensionCapability::RemoteAuthorityResolver => {
            ExtensionCapability::RemoteAuthorityResolver
        }
        EditorExtensionCapability::StatusBar => ExtensionCapability::StatusBar,
        EditorExtensionCapability::Command => ExtensionCapability::Command,
        EditorExtensionCapability::LanguageProvider => ExtensionCapability::LanguageProvider,
        EditorExtensionCapability::DebugAdapter => ExtensionCapability::DebugAdapter,
        EditorExtensionCapability::TaskProvider => ExtensionCapability::TaskProvider,
        EditorExtensionCapability::TestProfileProvider => ExtensionCapability::TestProfileProvider,
        EditorExtensionCapability::DataChannel => ExtensionCapability::DataChannel,
        EditorExtensionCapability::LinkPresentationProvider => {
            ExtensionCapability::LinkPresentationProvider
        }
        EditorExtensionCapability::ExternalUriOpener => ExtensionCapability::ExternalUriOpener,
    }
}

fn capability_name(capability: EditorExtensionCapability) -> &'static str {
    match capability {
        EditorExtensionCapability::RemoteAuthorityResolver => "remoteAuthorityResolver",
        EditorExtensionCapability::StatusBar => "statusBar",
        EditorExtensionCapability::Command => "command",
        EditorExtensionCapability::LanguageProvider => "languageProvider",
        EditorExtensionCapability::DebugAdapter => "debugAdapter",
        EditorExtensionCapability::TaskProvider => "taskProvider",
        EditorExtensionCapability::TestProfileProvider => "testProfileProvider",
        EditorExtensionCapability::DataChannel => "dataChannel",
        EditorExtensionCapability::LinkPresentationProvider => "linkPresentationProvider",
        EditorExtensionCapability::ExternalUriOpener => "externalUriOpener",
    }
}

struct PluginPackageAuthority {
    fence: PluginInvocationFence,
}

impl ActivationAuthority for PluginPackageAuthority {
    fn authorizes(&self) -> bool {
        self.fence.authorizes()
    }

    fn acquire(&self) -> Option<Box<dyn ActivationLease>> {
        Some(Box::new(PluginPackageLease {
            _lease: self.fence.acquire()?,
        }))
    }
}

struct PluginPackageLease {
    _lease: PluginInvocationLease,
}

impl ActivationLease for PluginPackageLease {}

#[cfg(test)]
#[path = "source_tests.rs"]
mod tests;
