use std::collections::BTreeMap;
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

#[derive(Clone)]
pub(crate) struct EditorExtensionDeployment {
    pub(crate) id: String,
    pub(crate) version: String,
    pub(crate) package_digest: String,
    pub(crate) command: ExtensionLaunchCommand,
    pub(crate) params: ActivateParams,
    pub(crate) authority: Arc<dyn ActivationAuthority>,
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
            let executable = package
                .resolve_file(&contribution.entrypoint)
                .map_err(|_| ExtensionHostRuntimeError::Host(ExtensionHostError::SpawnFailed))?;
            let command = ExtensionLaunchCommand::new(
                executable,
                std::iter::empty::<String>(),
                package.package_root(),
                BTreeMap::new(),
            )
            .map_err(ExtensionHostRuntimeError::Host)?;
            deployments.push(EditorExtensionDeployment {
                id: id.clone(),
                version: package.manifest().version.to_string(),
                package_digest: package.package_digest().as_str().to_string(),
                command,
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
        EditorExtensionCapability::Command => ExtensionCapability::Command,
        EditorExtensionCapability::LanguageProvider => ExtensionCapability::LanguageProvider,
        EditorExtensionCapability::DebugAdapter => ExtensionCapability::DebugAdapter,
        EditorExtensionCapability::TaskProvider => ExtensionCapability::TaskProvider,
        EditorExtensionCapability::TestProfileProvider => ExtensionCapability::TestProfileProvider,
        EditorExtensionCapability::DataChannel => ExtensionCapability::DataChannel,
        EditorExtensionCapability::LinkPresentationProvider => ExtensionCapability::LinkPresentationProvider,
    }
}

fn capability_name(capability: EditorExtensionCapability) -> &'static str {
    match capability {
        EditorExtensionCapability::Command => "command",
        EditorExtensionCapability::LanguageProvider => "languageProvider",
        EditorExtensionCapability::DebugAdapter => "debugAdapter",
        EditorExtensionCapability::TaskProvider => "taskProvider",
        EditorExtensionCapability::TestProfileProvider => "testProfileProvider",
        EditorExtensionCapability::DataChannel => "dataChannel",
        EditorExtensionCapability::LinkPresentationProvider => "linkPresentationProvider",
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
