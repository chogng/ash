use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use ash_core_plugins::ExtensionPackageManager;
use ash_core_plugins::PluginActivationAuthority;
use ash_core_plugins::PluginInvocationFence;
use ash_core_plugins::PluginInvocationLease;
use ash_external_ext::ActivateParams;
use ash_external_ext::ActivationAuthority;
use ash_external_ext::ActivationLease;
use ash_external_ext::ExtensionCapability;
use ash_external_ext::ExtensionHostError;
use ash_external_ext::ExtensionLaunchCommand;
use ash_external_ext::PackageBinding;
use ash_plugin::EditorExtensionActivationEvent;
use ash_plugin::EditorExtensionApi;
use ash_plugin::EditorExtensionCapability;

use super::ExtensionHostRuntimeError;
use crate::ExtensionsEditorExtensionAdmission;
use crate::extension_packages_editor_extensions;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct EditorExtensionSourceRevision {
    pub(crate) plugin: u64,
    pub(crate) extension_packages: u64,
    pub(crate) extension_packages_admission: u64,
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
    // Installed first-party runtime: no workspace IO grant, but exact package consent
    // and Manager leases remain authoritative for its entire process lifetime.
    ProductPackage,
}

#[derive(Clone)]
pub(crate) struct EditorExtensionDeployment {
    pub(crate) scope: EditorExtensionScope,
    pub(crate) id: String,
    pub(crate) version: String,
    pub(crate) package_digest: String,
    pub(crate) command: ExtensionLaunchCommand,
    pub(crate) workspace_read: WorkspaceReadAccess,
    pub(crate) credential_providers: Vec<String>,
    pub(crate) backend_channels: BTreeMap<String, String>,
    pub(crate) protocol_limits: Option<external_ext_protocol::ProtocolLimits>,
    pub(crate) params: ActivateParams,
    pub(crate) authority: Arc<dyn ActivationAuthority>,
    pub(crate) activation: Option<ActivationPlan>,
    pub(crate) activation_failure: Option<String>,
}

impl EditorExtensionDeployment {
    pub(super) fn is_window_scoped(&self) -> bool {
        self.command.is_node_host()
            || self.params.capabilities.iter().any(|capability| {
                matches!(
                    capability,
                    ExtensionCapability::SourceControl | ExtensionCapability::DebugAdapter
                )
            })
    }

    /// Reuse requires identical launch facts and both live authority fences.
    /// A package revocation must never be hidden by an unchanged digest.
    pub(super) fn can_reuse(&self, next: &Self) -> bool {
        self.scope == next.scope
            && self.id == next.id
            && self.version == next.version
            && self.package_digest == next.package_digest
            && self.command == next.command
            && self.workspace_read == next.workspace_read
            && self.credential_providers == next.credential_providers
            && self.backend_channels == next.backend_channels
            && self.protocol_limits == next.protocol_limits
            && self.params == next.params
            && self.activation == next.activation
            && self.activation_failure == next.activation_failure
            && self.authority.authorizes()
            && next.authority.authorizes()
    }
}

pub(super) fn built_in_deployments(
    selection: BuiltInEditorExtensions,
    admission: Option<Arc<dyn crate::ExtensionsEditorExtensionAdmission>>,
) -> Result<Vec<EditorExtensionDeployment>, ExtensionHostRuntimeError> {
    if selection == BuiltInEditorExtensions::Omitted {
        return Ok(Vec::new());
    }
    let executable = std::env::current_exe().map_err(|_| ExtensionHostRuntimeError::Internal)?;
    let directory = executable
        .parent()
        .ok_or(ExtensionHostRuntimeError::Internal)?;
    let mut deployments = vec![
        product_ssh_deployment(directory)?,
        product_markdown_math_deployment(directory)?,
        product_markdown_deployment(directory)?,
    ];
    // This optional package only supplies debugger policy. Missing binaries do
    // not make the shared host or non-debugging clients depend on LLDB.
    if directory
        .join(format!("ash-debug-lldb{}", std::env::consts::EXE_SUFFIX))
        .is_file()
    {
        deployments.push(product_lldb_deployment(directory)?);
    }
    for (name, manifest, sources) in [
        (
            "debug-javascript",
            include_str!("../../../../../extensions/debug-javascript/package.json"),
            concat!(
                include_str!("../../../../../extensions/debug-javascript/src/lib.rs"),
                include_str!("../../../../../extensions/debug-javascript/runtime.json"),
                include_str!("../../../../../extensions/debug-javascript/src/auto_attach.rs"),
                include_str!(
                    "../../../../../extensions/debug-javascript/src/auto_attach_controls.rs"
                ),
                include_str!("../../../../../extensions/debug-javascript/src/auto-attach.cjs"),
                include_str!("../../../../../extensions/debug-javascript/src/adapter-runtime.cjs"),
                include_str!("../../../../../extensions/debug-javascript/package.nls.json"),
                include_str!("../../../../../extensions/debug-javascript/package.nls.zh-CN.json"),
            ),
        ),
        (
            "debug-server-ready",
            include_str!("../../../../../extensions/debug-server-ready/package.json"),
            concat!(
                include_str!("../../../../../extensions/debug-server-ready/src/lib.rs"),
                include_str!("../../../../../extensions/debug-server-ready/package.nls.json"),
                include_str!("../../../../../extensions/debug-server-ready/package.nls.zh-CN.json"),
            ),
        ),
    ] {
        if directory
            .join(format!("ash-{name}{}", std::env::consts::EXE_SUFFIX))
            .is_file()
        {
            deployments.push(product_debug_workflow_deployment(
                directory, name, manifest, sources,
            )?);
        }
    }
    let git_manifest: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../extensions/git/package.json"))
            .map_err(|_| ExtensionHostRuntimeError::Internal)?;
    if git_manifest["ashRuntime"]["kind"] == "rust" {
        deployments.push(product_git_deployment(directory)?);
    }
    for deployment in &mut deployments {
        deployment.authority = Arc::new(ProductPolicyAuthority {
            id: deployment.id.clone(),
            admission: admission.clone(),
        });
    }
    Ok(deployments)
}

fn product_debug_workflow_deployment(
    directory: &Path,
    name: &str,
    manifest_source: &str,
    sources: &str,
) -> Result<EditorExtensionDeployment, ExtensionHostRuntimeError> {
    let manifest: serde_json::Value =
        serde_json::from_str(manifest_source).map_err(|_| ExtensionHostRuntimeError::Internal)?;
    let digest = format!(
        "sha256:{:x}",
        Sha256::digest(format!(
            "{manifest_source}\0{sources}\0{}\0{}\0{}",
            include_str!("../../../../../sdk/rust/src/debug.rs"),
            include_str!("../../../../../sdk/rust/src/client.rs"),
            include_str!("../../../../../sdk/rust/src/terminal.rs")
        ))
    );
    let events: Vec<String> = serde_json::from_value(manifest["activationEvents"].clone())
        .map_err(|_| ExtensionHostRuntimeError::Internal)?;
    let id = format!("ash.{name}");
    let executable = format!("ash-{name}{}", std::env::consts::EXE_SUFFIX);
    let mut environment = BTreeMap::new();
    if name == "debug-javascript" {
        environment.extend(
            exec_server::terminal::safe_process_environment()
                .into_iter()
                .filter(|(key, _)| {
                    // The adapter needs OS helpers to terminate launched targets.
                    // Do not transfer the whole host environment to the provider.
                    matches!(
                        key.to_ascii_uppercase().as_str(),
                        "PATH"
                            | "HOME"
                            | "USERPROFILE"
                            | "SYSTEMROOT"
                            | "WINDIR"
                            | "COMSPEC"
                            | "PATHEXT"
                            | "TEMP"
                            | "TMP"
                            | "TMPDIR"
                    )
                })
                .map(|(key, value)| (key.into(), value.into())),
        );
        if let Some(node) = std::env::var_os("ASH_ELECTRON_RUN_AS_NODE_PATH") {
            environment.insert("ASH_DEBUG_NODE_PATH".into(), node);
            environment.insert("ASH_DEBUG_ELECTRON".into(), "1".into());
        } else if let Some(root) = directory.parent() {
            environment.insert(
                "ASH_DEBUG_NODE_PATH".into(),
                root.join("ash-resources/node/bin")
                    .join(format!("node{}", std::env::consts::EXE_SUFFIX))
                    .into_os_string(),
            );
        }
    }
    Ok(EditorExtensionDeployment {
        scope: EditorExtensionScope::Product,
        id: id.clone(),
        version: "1.0.0".into(),
        package_digest: digest.clone(),
        command: ExtensionLaunchCommand::new(
            directory.join(&executable),
            std::iter::empty::<String>(),
            directory,
            environment,
        )
        .map_err(ExtensionHostRuntimeError::Host)?,
        workspace_read: WorkspaceReadAccess::Denied,
        credential_providers: Vec::new(),
        backend_channels: BTreeMap::new(),
        protocol_limits: None,
        params: ActivateParams {
            initialization: None,
            extension_id: id.clone(),
            package: PackageBinding {
                package_id: format!("{id}@1.0.0"),
                package_digest: digest,
                entrypoint: executable,
            },
            runtime_api_version: 1,
            activation_events: events.clone(),
            capabilities: if name == "debug-javascript" {
                vec![
                    ExtensionCapability::DebugAdapter,
                    ExtensionCapability::TerminalProfileProvider,
                    ExtensionCapability::Command,
                    ExtensionCapability::StatusBar,
                ]
            } else {
                vec![ExtensionCapability::DebugAdapter]
            },
        },
        authority: Arc::new(ProductAuthority),
        activation: Some(ActivationPlan {
            events,
            commands: manifest["contributes"]["commands"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|command| {
                    command["command"]
                        .as_str()
                        .zip(command["title"].as_str())
                        .map(|(id, title)| (id.to_owned(), title.to_owned()))
                })
                .collect(),
        }),
        activation_failure: None,
    })
}

pub(super) fn product_lldb_deployment(
    directory: &Path,
) -> Result<EditorExtensionDeployment, ExtensionHostRuntimeError> {
    let manifest: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../extensions/debug-lldb/package.json"
    ))
    .map_err(|_| ExtensionHostRuntimeError::Internal)?;
    let digest = format!(
        "sha256:{:x}",
        Sha256::digest(concat!(
            include_str!("../../../../../extensions/debug-lldb/package.json"),
            include_str!("../../../../../extensions/debug-lldb/package.nls.json"),
            include_str!("../../../../../extensions/debug-lldb/package.nls.zh-CN.json"),
            include_str!("../../../../../extensions/debug-lldb/src/lib.rs"),
            include_str!("../../../../../extensions/debug-lldb/src/installer.rs"),
            include_str!("../../../../../extensions/debug-lldb/runtime.json"),
            include_str!("../../../../../sdk/rust/src/debug.rs"),
            include_str!("../../../../../sdk/rust/src/window.rs"),
        ))
    );
    let events: Vec<String> = serde_json::from_value(manifest["activationEvents"].clone())
        .map_err(|_| ExtensionHostRuntimeError::Internal)?;
    Ok(EditorExtensionDeployment {
        scope: EditorExtensionScope::Product,
        id: "ash.debug-lldb".into(),
        version: "1.0.0".into(),
        package_digest: digest.clone(),
        command: ExtensionLaunchCommand::new(
            directory.join(format!("ash-debug-lldb{}", std::env::consts::EXE_SUFFIX)),
            std::iter::empty::<String>(),
            directory,
            BTreeMap::new(),
        )
        .map_err(ExtensionHostRuntimeError::Host)?,
        workspace_read: WorkspaceReadAccess::Denied,
        credential_providers: Vec::new(),
        backend_channels: BTreeMap::new(),
        protocol_limits: None,
        params: ActivateParams {
            initialization: None,
            extension_id: "ash.debug-lldb".into(),
            package: PackageBinding {
                package_id: "ash.debug-lldb@1.0.0".into(),
                package_digest: digest,
                entrypoint: "ash-debug-lldb".into(),
            },
            runtime_api_version: 1,
            activation_events: events.clone(),
            capabilities: vec![
                ExtensionCapability::DebugAdapter,
                ExtensionCapability::Command,
                ExtensionCapability::StatusBar,
            ],
        },
        authority: Arc::new(ProductAuthority),
        activation: Some(ActivationPlan {
            events,
            commands: manifest["contributes"]["commands"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|command| {
                    command["command"]
                        .as_str()
                        .zip(command["title"].as_str())
                        .map(|(id, title)| (id.to_owned(), title.to_owned()))
                })
                .collect(),
        }),
        activation_failure: None,
    })
}

fn product_ssh_deployment(
    directory: &Path,
) -> Result<EditorExtensionDeployment, ExtensionHostRuntimeError> {
    let source = include_str!("../../../../../extensions/remote-ssh/src/main.rs");
    let manifest = include_str!("../../../../../extensions/remote-ssh/package.json");
    let sdk = include_str!("../../../../../sdk/rust/src/workspace.rs");
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
        command: ExtensionLaunchCommand::new(
            directory.join(format!(
                "ash-remote-ssh-extension{}",
                std::env::consts::EXE_SUFFIX
            )),
            std::iter::empty::<String>(),
            directory,
            BTreeMap::new(),
        )
        .map_err(ExtensionHostRuntimeError::Host)?,
        workspace_read: WorkspaceReadAccess::Denied,
        credential_providers: Vec::new(),
        backend_channels: BTreeMap::new(),
        protocol_limits: None,
        params: ActivateParams {
            initialization: None,
            extension_id: id,
            package: PackageBinding {
                package_id: "ash.remote-ssh@1.0.0".into(),
                package_digest: digest,
                entrypoint: "ash-remote-ssh-extension".into(),
            },
            runtime_api_version: 1,
            activation_events: vec!["onResolveRemoteAuthority:ssh".into()],
            capabilities: vec![
                ExtensionCapability::RemoteAuthorityResolver,
                ExtensionCapability::ProductRemoteAuthorityResolver,
            ],
        },
        authority: Arc::new(ProductAuthority),
        activation: Some(ActivationPlan {
            events: vec!["onResolveRemoteAuthority:ssh".into()],
            commands: Vec::new(),
        }),
        activation_failure: None,
    })
}

pub(super) fn product_markdown_math_deployment(
    directory: &Path,
) -> Result<EditorExtensionDeployment, ExtensionHostRuntimeError> {
    let manifest = include_str!("../../../../../extensions/markdown-math/package.json");
    let source = include_str!("../../../../../extensions/markdown-math/src/lib.rs");
    let contract = include_str!("../../../../../crates/utils/markdown-math/src/lib.rs");
    let digest = format!(
        "sha256:{:x}",
        Sha256::digest(format!("{manifest}\0{source}\0{contract}"))
    );
    let id = "ash.markdown-math".to_owned();
    Ok(EditorExtensionDeployment {
        scope: EditorExtensionScope::Product,
        id: id.clone(),
        version: "1.0.0".into(),
        package_digest: digest.clone(),
        command: ExtensionLaunchCommand::new(
            directory.join(format!("ash-markdown-math{}", std::env::consts::EXE_SUFFIX)),
            std::iter::empty::<String>(),
            directory,
            BTreeMap::new(),
        )
        .map_err(ExtensionHostRuntimeError::Host)?,
        workspace_read: WorkspaceReadAccess::Denied,
        credential_providers: Vec::new(),
        backend_channels: BTreeMap::new(),
        protocol_limits: None,
        params: ActivateParams {
            initialization: None,
            extension_id: id,
            package: PackageBinding {
                package_id: "ash.markdown-math@1.0.0".into(),
                package_digest: digest,
                entrypoint: "ash-markdown-math".into(),
            },
            runtime_api_version: 1,
            activation_events: vec!["onCapability:math.render.v2".into()],
            capabilities: vec![ExtensionCapability::DataChannel],
        },
        authority: Arc::new(ProductAuthority),
        activation: Some(ActivationPlan {
            events: vec!["onCapability:math.render.v2".into()],
            commands: Vec::new(),
        }),
        activation_failure: None,
    })
}

fn product_markdown_deployment(
    directory: &Path,
) -> Result<EditorExtensionDeployment, ExtensionHostRuntimeError> {
    let manifest =
        include_str!("../../../../../extensions/markdown-language-features/package.json");
    let source = [
        include_str!("../../../../../extensions/markdown-language-features/src/parser.rs"),
        include_str!("../../../../../extensions/markdown-language-features/src/math.rs"),
        include_str!("../../../../../extensions/markdown-language-features/src/lib.rs"),
        include_str!("../../../../../extensions/markdown-language-features/src/language.rs"),
        include_str!("../../../../../extensions/markdown-language-features/package.nls.json"),
        include_str!("../../../../../extensions/markdown-language-features/package.nls.zh-CN.json"),
        include_str!("../../../../../extensions/markdown-language-features/media/markdown.css"),
        include_str!("../../../../../sdk/rust/src/editors.rs"),
        include_str!("../../../../../sdk/rust/src/languages.rs"),
    ]
    .join("\0");
    let digest = format!(
        "sha256:{:x}",
        Sha256::digest(format!("{manifest}\0{source}"))
    );
    let manifest_value: serde_json::Value =
        serde_json::from_str(manifest).map_err(|_| ExtensionHostRuntimeError::Internal)?;
    let commands = manifest_value["contributes"]["commands"]
        .as_array()
        .ok_or(ExtensionHostRuntimeError::Internal)?
        .iter()
        .filter_map(|entry| {
            entry["command"]
                .as_str()
                .map(|id| (id.to_owned(), id.to_owned()))
        })
        .collect::<Vec<_>>();
    let mut events = manifest_value["activationEvents"]
        .as_array()
        .ok_or(ExtensionHostRuntimeError::Internal)?
        .iter()
        .filter_map(|event| event.as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    // Contributed commands must be callable before startup restoration completes,
    // matching the manifest-derived activation facts used by the client.
    events.extend(
        commands
            .iter()
            .map(|(command, _)| format!("onCommand:{command}")),
    );
    // Restore custom-editor tabs from their declarations without starting the provider.
    // Resolving the first document activates the matching view through the same capability gate.
    events.extend(
        manifest_value["contributes"]["customEditors"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|editor| editor["viewType"].as_str())
            .map(|view| format!("onCapability:customEditor:{view}")),
    );
    Ok(EditorExtensionDeployment {
        scope: EditorExtensionScope::Product,
        id: "ash.markdown-language-features".into(),
        version: "1.0.0".into(),
        package_digest: digest.clone(),
        command: ExtensionLaunchCommand::new(
            directory.join(format!(
                "ash-markdown-language-features{}",
                std::env::consts::EXE_SUFFIX
            )),
            std::iter::empty::<String>(),
            directory,
            BTreeMap::new(),
        )
        .map_err(ExtensionHostRuntimeError::Host)?,
        workspace_read: WorkspaceReadAccess::Read,
        credential_providers: Vec::new(),
        backend_channels: serde_json::from_str::<serde_json::Value>(manifest)
            .ok()
            .and_then(|manifest| {
                serde_json::from_value(manifest["ashRuntime"]["requires"].clone()).ok()
            })
            .ok_or(ExtensionHostRuntimeError::Internal)?,
        protocol_limits: Some(external_ext_protocol::ProtocolLimits {
            maximum_frame_bytes: 32 * 1024 * 1024,
            maximum_payload_bytes: 24 * 1024 * 1024,
            ..Default::default()
        }),
        params: ActivateParams {
            initialization: None,
            extension_id: "ash.markdown-language-features".into(),
            package: PackageBinding {
                package_id: "ash.markdown-language-features@1.0.0".into(),
                package_digest: digest,
                entrypoint: "ash-markdown-language-features".into(),
            },
            runtime_api_version: 1,
            activation_events: events.clone(),
            capabilities: vec![
                ExtensionCapability::Command,
                ExtensionCapability::CustomTextEditor,
                ExtensionCapability::LanguageProvider,
            ],
        },
        authority: Arc::new(ProductAuthority),
        activation: Some(ActivationPlan { events, commands }),
        activation_failure: None,
    })
}

fn product_git_deployment(
    directory: &Path,
) -> Result<EditorExtensionDeployment, ExtensionHostRuntimeError> {
    let manifest = include_str!("../../../../../extensions/git/package.json");
    let source = [
        include_str!("../../../../../extensions/git/src/lib.rs"),
        include_str!("../../../../../extensions/git/src/api.rs"),
        include_str!("../../../../../extensions/git/src/blame.rs"),
        include_str!("../../../../../extensions/git/src/interaction.rs"),
        include_str!("../../../../../sdk/rust/src/terminal.rs"),
        include_str!("../../../../../extensions/git/src/model.rs"),
        include_str!("../../../../../extensions/git/src/paths.rs"),
        include_str!("../../../../../extensions/git/src/commands.rs"),
        include_str!("../../../../../extensions/git/src/scm.rs"),
        include_str!("../../../../../extensions/git/src/history.rs"),
        include_str!("../../../../../extensions/git/src/changes.rs"),
        include_str!("../../../../../sdk/rust/src/scm.rs"),
    ]
    .join("\0");
    let digest = format!(
        "sha256:{:x}",
        Sha256::digest(format!("{manifest}\0{source}"))
    );
    let manifest_value: serde_json::Value =
        serde_json::from_str(manifest).map_err(|_| ExtensionHostRuntimeError::Internal)?;
    // Preserve the package's eager activation: deferring this to startupFinished
    // serializes Git discovery behind unrelated Workbench restoration.
    let events: Vec<String> = serde_json::from_value(manifest_value["activationEvents"].clone())
        .map_err(|_| ExtensionHostRuntimeError::Internal)?;
    let commands = manifest_value["contributes"]["commands"]
        .as_array()
        .ok_or(ExtensionHostRuntimeError::Internal)?
        .iter()
        .filter_map(|entry| {
            entry["command"]
                .as_str()
                .map(|command| (command.to_owned(), command.to_owned()))
        })
        .collect();
    Ok(EditorExtensionDeployment {
        scope: EditorExtensionScope::Product,
        id: "ash.git".into(),
        version: "0.1.0".into(),
        package_digest: digest.clone(),
        command: ExtensionLaunchCommand::new(
            directory.join(format!("ash-git-extension{}", std::env::consts::EXE_SUFFIX)),
            std::iter::empty::<String>(),
            directory,
            BTreeMap::new(),
        )
        .map_err(ExtensionHostRuntimeError::Host)?,
        workspace_read: WorkspaceReadAccess::Read,
        credential_providers: vec!["github".into()],
        backend_channels: BTreeMap::new(),
        protocol_limits: Some(external_ext_protocol::ProtocolLimits {
            maximum_frame_bytes: 32 * 1024 * 1024,
            maximum_payload_bytes: 24 * 1024 * 1024,
            ..Default::default()
        }),
        params: ActivateParams {
            initialization: None,
            extension_id: "ash.git".into(),
            package: PackageBinding {
                package_id: "ash.git@0.1.0".into(),
                package_digest: digest,
                entrypoint: "ash-git-extension".into(),
            },
            runtime_api_version: 1,
            activation_events: events.clone(),
            capabilities: vec![
                ExtensionCapability::Command,
                ExtensionCapability::SourceControl,
                ExtensionCapability::TerminalProfileProvider,
            ],
        },
        authority: Arc::new(ProductAuthority),
        activation: Some(ActivationPlan { events, commands }),
        activation_failure: None,
    })
}

struct ProductPolicyAuthority {
    id: String,
    admission: Option<Arc<dyn crate::ExtensionsEditorExtensionAdmission>>,
}
impl ActivationAuthority for ProductPolicyAuthority {
    fn authorizes(&self) -> bool {
        self.admission
            .as_ref()
            .is_none_or(|admission| admission.is_product_extension_enabled(&self.id))
    }
    fn acquire(&self) -> Option<Box<dyn ActivationLease>> {
        self.authorizes()
            .then(|| Box::new(ProductLease) as Box<dyn ActivationLease>)
    }
}

// This authority admits only the extension shipped in the product installation. Fleet retirement
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
    Capability(String),
    Command(String),
    Language(String),
    TaskType(Option<String>),
    TerminalProfile(String),
    Debug {
        phase: DebugActivationPhase,
        debug_type: Option<String>,
    },
    StartupFinished,
    Speech,
    ResolveAuthority(String),
}

#[derive(Clone, Copy, Debug)]
pub(in crate::server) enum DebugActivationPhase {
    Start,
    InitialConfigurations,
    DynamicConfigurations,
    ResolveConfiguration,
}

impl DebugActivationPhase {
    fn event_name(self) -> &'static str {
        match self {
            Self::Start => "onDebug",
            Self::InitialConfigurations => "onDebugInitialConfigurations",
            Self::DynamicConfigurations => "onDebugDynamicConfigurations",
            Self::ResolveConfiguration => "onDebugResolve",
        }
    }
}

impl ActivationPlan {
    pub(super) fn matches(&self, event: &ActivationEvent) -> bool {
        if self.events.iter().any(|event| event == "*") {
            return true;
        }
        match event {
            ActivationEvent::Capability(channel) => self.events.iter().any(|event| {
                event == &format!("onCapability:{channel}")
                    || event == &format!("onDemand:{channel}")
            }),
            ActivationEvent::Command(command) => self
                .events
                .iter()
                .any(|event| event == &format!("onCommand:{command}")),
            ActivationEvent::Language(language) => self
                .events
                .iter()
                .any(|event| event == "onLanguage" || event == &format!("onLanguage:{language}")),
            ActivationEvent::TerminalProfile(id) => self.events.iter().any(|event| {
                event == &format!("onTerminalProfile:{id}")
                    || event == "onDemand:terminalProfileProvider"
            }),
            ActivationEvent::TaskType(task_type) => self.events.iter().any(|event| {
                event == "onTaskType"
                    || event == "onDemand:taskProvider"
                    || task_type
                        .as_ref()
                        .is_some_and(|task_type| event == &format!("onTaskType:{task_type}"))
            }),
            ActivationEvent::Debug { phase, debug_type } => self.events.iter().any(|event| {
                event == phase.event_name()
                    || event == "onDemand:debugAdapter"
                    || debug_type.as_ref().is_some_and(|debug_type| {
                        event == &format!("{}:{debug_type}", phase.event_name())
                            || event == &format!("onDebugType:{debug_type}")
                    })
            }),
            ActivationEvent::ResolveAuthority(prefix) => self.events.iter().any(|event| {
                event == "onDemand:remoteAuthorityResolver"
                    || event == &format!("onResolveRemoteAuthority:{prefix}")
            }),
            ActivationEvent::Speech => self
                .events
                .iter()
                .any(|event| event == "onSpeech" || event == "onDemand:speechProvider"),
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
            // Old package metadata remains readable for management and uninstall. It
            // cannot select the Ash runtime merely because the package is still enabled.
            if contribution.runtime == ash_plugin::EditorExtensionRuntime::JavaScript
                && contribution.api == EditorExtensionApi::Retired
            {
                continue;
            }
            let id = stable_extension_id(package.manifest().id.as_str(), contribution.id.as_str());
            let entry = package
                .resolve_file(&contribution.entrypoint)
                .map_err(|_| ExtensionHostRuntimeError::Host(ExtensionHostError::SpawnFailed))?;
            let command = match contribution.runtime {
                ash_plugin::EditorExtensionRuntime::HostRpc => ExtensionLaunchCommand::new(
                    entry,
                    Vec::<String>::new(),
                    package.package_root(),
                    BTreeMap::new(),
                ),
                ash_plugin::EditorExtensionRuntime::JavaScript => {
                    let root = package
                        .package_root()
                        .to_str()
                        .ok_or(ExtensionHostRuntimeError::Internal)?
                        .to_string();
                    let arguments = {
                        let mut arguments = vec![
                            "--extension-id".into(),
                            id.clone(),
                            "--package".into(),
                            root,
                            "--entry".into(),
                            contribution.entrypoint.as_str().into(),
                        ];
                        arguments.extend(["--api".into(), "ash".into()]);
                        arguments
                    };
                    ExtensionLaunchCommand::ash(arguments, package.package_root())
                }
            }
            .map_err(ExtensionHostRuntimeError::Host)?;
            let (activation, activation_failure) = match contribution.runtime {
                ash_plugin::EditorExtensionRuntime::JavaScript => {
                    match extension_packages_editor_extensions::javascript_activation_plan(
                        package.package_root(),
                    ) {
                        Ok(plan) => (Some(plan), None),
                        Err(message) => (None, Some(message)),
                    }
                }
                ash_plugin::EditorExtensionRuntime::HostRpc => (None, None),
            };
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
                credential_providers: Vec::new(),
                backend_channels: BTreeMap::new(),
                protocol_limits: None,
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
                    initialization: None,
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
                    activation_events: activation
                        .as_ref()
                        .map(|plan| plan.events.clone())
                        .unwrap_or_else(|| {
                            contribution
                                .activation_events
                                .iter()
                                .map(activation_event)
                                .collect()
                        }),
                    capabilities: contribution
                        .capabilities
                        .iter()
                        .copied()
                        .map(extension_capability)
                        .collect(),
                },
                activation,
                activation_failure,
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
            extension_packages: 0,
            extension_packages_admission: 0,
        },
        deployments,
    })
}

pub(super) fn combined_deployments(
    plugin: Option<&PluginActivationAuthority>,
    extension_packages: Option<&Arc<ExtensionPackageManager>>,
    extension_packages_admission: Option<&Arc<dyn ExtensionsEditorExtensionAdmission>>,
) -> Result<EditorExtensionSourceSnapshot, ExtensionHostRuntimeError> {
    let mut snapshot = match plugin {
        Some(plugin) => plugin_deployments(plugin)?,
        None => EditorExtensionSourceSnapshot {
            revision: EditorExtensionSourceRevision::default(),
            deployments: Vec::new(),
        },
    };
    if let Some(admission) = extension_packages_admission {
        snapshot.revision.extension_packages_admission = admission.generation();
    }
    if let (Some(manager), Some(admission)) = (extension_packages, extension_packages_admission) {
        snapshot.revision.extension_packages = manager
            .generation()
            .map_err(|_| ExtensionHostRuntimeError::Internal)?;
        snapshot.deployments.extend(
            extension_packages_editor_extensions::deployments(manager, admission)
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
        EditorExtensionActivationEvent::OnTerminalProfile { profile_id } => {
            format!("onTerminalProfile:{profile_id}")
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
        EditorExtensionCapability::SourceControl => ExtensionCapability::SourceControl,
        EditorExtensionCapability::LanguageProvider => ExtensionCapability::LanguageProvider,
        EditorExtensionCapability::CustomTextEditor => ExtensionCapability::CustomTextEditor,
        EditorExtensionCapability::DebugAdapter => ExtensionCapability::DebugAdapter,
        EditorExtensionCapability::TaskProvider => ExtensionCapability::TaskProvider,
        EditorExtensionCapability::TerminalProfileProvider => {
            ExtensionCapability::TerminalProfileProvider
        }
        EditorExtensionCapability::TerminalCompletionProvider => {
            ExtensionCapability::TerminalCompletionProvider
        }
        EditorExtensionCapability::TerminalQuickFixProvider => {
            ExtensionCapability::TerminalQuickFixProvider
        }
        EditorExtensionCapability::TerminalLinkProvider => {
            ExtensionCapability::TerminalLinkProvider
        }
        EditorExtensionCapability::TestProfileProvider => ExtensionCapability::TestProfileProvider,
        EditorExtensionCapability::DataChannel => ExtensionCapability::DataChannel,
        EditorExtensionCapability::SpeechProvider => ExtensionCapability::SpeechProvider,
        EditorExtensionCapability::TreeView => ExtensionCapability::TreeView,
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
        EditorExtensionCapability::SourceControl => "sourceControl",
        EditorExtensionCapability::LanguageProvider => "languageProvider",
        EditorExtensionCapability::CustomTextEditor => "customTextEditor",
        EditorExtensionCapability::DebugAdapter => "debugAdapter",
        EditorExtensionCapability::TaskProvider => "taskProvider",
        EditorExtensionCapability::TerminalProfileProvider => "terminalProfileProvider",
        EditorExtensionCapability::TerminalLinkProvider => "terminalLinkProvider",
        EditorExtensionCapability::TerminalCompletionProvider => "terminalCompletionProvider",
        EditorExtensionCapability::TerminalQuickFixProvider => "terminalQuickFixProvider",
        EditorExtensionCapability::TestProfileProvider => "testProfileProvider",
        EditorExtensionCapability::DataChannel => "dataChannel",
        EditorExtensionCapability::SpeechProvider => "speechProvider",
        EditorExtensionCapability::TreeView => "treeView",
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
