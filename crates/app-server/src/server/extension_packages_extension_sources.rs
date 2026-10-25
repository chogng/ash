use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::Mutex;

use ash_core_plugins::CapabilityKind;
use ash_core_plugins::ExtensionPackageManager;
use ash_core_plugins::LocalCapabilitySource;
use ash_external_ext::packages::DynamicExtensionPackageSource;
use ash_external_ext::packages::DynamicExtensionSourceProvider;
use ash_external_ext::packages::DynamicExtensionSourceSnapshot;
use ash_external_ext::packages::ExtensionDiagnostic;
use ash_external_ext::packages::ExtensionDiagnosticCode;
use ash_external_ext::packages::ExtensionRendererClient;
use ash_external_ext::packages::ExtensionRootKind;
use serde::Deserialize;

use crate::extension_packages_editor_extensions::product_runtime_extension_id;

/// Projects installed Extensions declarative editor assets into the Extension catalog.
pub(super) struct ExtensionsExtensionSourceProvider {
    manager: Arc<ExtensionPackageManager>,
    policy: Option<Arc<ash_core_plugins::EditorExtensionPolicy>>,
    state: Mutex<ProjectionState>,
}

#[derive(Default)]
struct ProjectionState {
    fingerprint: Vec<String>,
    generation: u64,
}

impl ExtensionsExtensionSourceProvider {
    pub(super) fn new(
        manager: Arc<ExtensionPackageManager>,
        policy: Option<Arc<ash_core_plugins::EditorExtensionPolicy>>,
    ) -> Self {
        Self {
            manager,
            policy,
            state: Mutex::new(ProjectionState::default()),
        }
    }
}

impl DynamicExtensionSourceProvider for ExtensionsExtensionSourceProvider {
    fn snapshot(&self) -> Result<DynamicExtensionSourceSnapshot, String> {
        let mut sources = Vec::new();
        let mut diagnostics = Vec::new();
        let mut product_packages = BTreeSet::new();
        for kind in [
            CapabilityKind::Executable,
            CapabilityKind::Language,
            CapabilityKind::Theme,
            CapabilityKind::EditorExtension,
        ] {
            let selected = match self.manager.local_capability_source_snapshot(kind) {
                Ok(snapshot) => {
                    diagnostics.extend(snapshot.failures.into_iter().map(|(package, error)| {
                        ExtensionDiagnostic {
                            source: "extensions".into(),
                            subject: Some(package.id.chars().take(256).collect()),
                            code: ExtensionDiagnosticCode::SourceUnavailable,
                            message: error.to_string().chars().take(512).collect(),
                        }
                    }));
                    snapshot.sources
                }
                Err(error) => {
                    diagnostics.push(ExtensionDiagnostic {
                        source: "extensions".into(),
                        subject: Some(format!("{kind:?}")),
                        code: ExtensionDiagnosticCode::SourceUnavailable,
                        message: error.to_string().chars().take(512).collect(),
                    });
                    continue;
                }
            };
            for source in selected {
                // The executable projection already carries this exact editor asset's
                // original identity and routing declarations. Do not publish a second owner.
                if kind == CapabilityKind::EditorExtension
                    && source.is_product_runtime()
                    && product_packages
                        .contains(&(source.package().id.clone(), source.package().digest.clone()))
                {
                    continue;
                }
                let runtime_id = if kind == CapabilityKind::Executable {
                    match product_runtime_extension_id(&source) {
                        Ok(Some(id)) => Some(id),
                        Ok(None) => continue,
                        Err(message) => {
                            diagnostics.push(source_diagnostic(&source, message));
                            continue;
                        }
                    }
                } else if kind == CapabilityKind::EditorExtension
                    && source.is_product_runtime()
                    && source.editor_extension_root() == Some(source.host_path())
                {
                    // A supported editor asset keeps its original routes even when this
                    // package has no executable for the current host platform.
                    match ash_utils_plugins::PluginId::parse(&source.package().id) {
                        Ok(id) => Some(id.plugin_name().to_string()),
                        Err(_) => {
                            diagnostics.push(source_diagnostic(
                                &source,
                                "Product editor package identity is invalid".into(),
                            ));
                            continue;
                        }
                    }
                } else {
                    None
                };
                if kind == CapabilityKind::Executable && runtime_id.is_some() {
                    product_packages
                        .insert((source.package().id.clone(), source.package().digest.clone()));
                }
                let admission = self
                    .policy
                    .as_ref()
                    .map(|policy| policy.snapshot(source.package(), source.capability()));
                // Trusted executable declarations reserve their document routes even before
                // consent or while disabled. Execution admission always retires independently.
                if runtime_id.is_none() && admission.is_some_and(|policy| !policy.enabled) {
                    continue;
                }
                let manifest = normalized_extension_manifest(&source, runtime_id.as_deref());
                match manifest {
                    Ok(manifest) => {
                        let client = match runtime_id.as_deref() {
                            Some(id)
                                if kind == CapabilityKind::Executable
                                    && admission
                                        .is_some_and(|policy| policy.enabled && policy.granted) =>
                            {
                                match renderer_client(id, &manifest) {
                                    Ok(client) => client,
                                    Err(message) => {
                                        diagnostics.push(source_diagnostic(&source, message));
                                        None
                                    }
                                }
                            }
                            Some(_) | None => None,
                        };
                        sources.push((source, manifest, client));
                    }
                    Err(message) => diagnostics.push(source_diagnostic(&source, message)),
                }
            }
        }
        sources.sort_by(|left, right| {
            (
                left.0.package().id.as_str(),
                left.0.package().version.as_str(),
                left.0.id(),
                left.0.capability().id.as_str(),
            )
                .cmp(&(
                    right.0.package().id.as_str(),
                    right.0.package().version.as_str(),
                    right.0.id(),
                    right.0.capability().id.as_str(),
                ))
        });
        let mut fingerprint = sources
            .iter()
            .map(|(source, _, client)| {
                format!(
                    "{}\0{}\0{}\0{}\0{client:?}",
                    source.package().id,
                    source.package().version,
                    source.package().digest,
                    source.capability().id
                )
            })
            .collect::<Vec<_>>();
        fingerprint.extend(
            diagnostics
                .iter()
                .map(|diagnostic| format!("{diagnostic:?}")),
        );
        let generation = next_generation(&self.state, fingerprint)?;
        let packages = sources
            .into_iter()
            .map(|(source, normalized_manifest, client)| {
                let subject = format!("{}:{}", source.package().id, source.id());
                let path = if source.kind() == CapabilityKind::Executable {
                    source
                        .editor_extension_root()
                        .unwrap_or(source.package_root())
                        .to_path_buf()
                } else {
                    source.host_path().to_path_buf()
                };
                let mut package = DynamicExtensionPackageSource::extension_packages_with_manifest(
                    subject,
                    path,
                    normalized_manifest,
                );
                package.verified_package_sha256 = Some(source.package().digest.clone());
                package.renderer_client = client;
                package
            })
            .collect();
        Ok(DynamicExtensionSourceSnapshot {
            generation,
            packages,
            diagnostics,
        })
    }
}

fn source_diagnostic(source: &LocalCapabilitySource, message: String) -> ExtensionDiagnostic {
    ExtensionDiagnostic {
        source: "extensions".into(),
        subject: Some(
            format!("{}:{}", source.package().id, source.id())
                .chars()
                .take(256)
                .collect(),
        ),
        code: ExtensionDiagnosticCode::InvalidManifest,
        message: message.chars().take(512).collect(),
    }
}

fn normalized_extension_manifest(
    source: &LocalCapabilitySource,
    runtime_id: Option<&str>,
) -> Result<String, String> {
    let root = if runtime_id.is_some() {
        source
            .editor_extension_root()
            .unwrap_or(source.package_root())
            .to_path_buf()
    } else {
        source.host_path().to_path_buf()
    };
    let path = root.join("package.json");
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|_| "Extensions language manifest is unavailable".to_string())?;
    let maximum = if source.kind() == CapabilityKind::Theme {
        64 * 1024
    } else {
        4 * 1024 * 1024
    };
    if !metadata.is_file() || metadata.len() > maximum {
        return Err("Extensions language manifest exceeds its file contract".into());
    }
    let mut manifest: serde_json::Map<String, serde_json::Value> = serde_json::from_slice(
        &std::fs::read(path)
            .map_err(|_| "Extensions language manifest is unavailable".to_string())?,
    )
    .map_err(|_| "Extensions language manifest is invalid".to_string())?;
    let plugin = ash_utils_plugins::PluginId::parse(&source.package().id)
        .map_err(|_| "Extensions language package identity is invalid".to_string())?;
    if let Some(runtime_id) = runtime_id {
        let name = manifest.get("name").and_then(serde_json::Value::as_str);
        let publisher = manifest
            .get("publisher")
            .and_then(serde_json::Value::as_str);
        if !matches!((publisher, name), (Some(publisher), Some(name)) if format!("{publisher}.{name}") == runtime_id)
        {
            return Err(
                "Product editor manifest identity does not match its verified runtime".into(),
            );
        }
    } else {
        manifest.insert("name".into(), plugin.plugin_name().into());
        manifest.insert("publisher".into(), plugin.source_id().as_str().into());
        manifest.remove("ashRuntime");
    }
    // This name is reserved for the host's descriptor proof, including on trusted packages.
    manifest.remove("rendererClient");
    manifest.insert("version".into(), source.package().version.clone().into());
    if source.kind() == CapabilityKind::EditorExtension && runtime_id.is_none() {
        // Without a verified runtime, editor packages may contribute resources and user-triggered keybindings.
        // A declarative debugger must not turn an ungranted package into process execution.
        for entry in ["main", "browser", "activationEvents"] {
            manifest.remove(entry);
        }
        if let Some(contributes) = manifest
            .get_mut("contributes")
            .and_then(serde_json::Value::as_object_mut)
        {
            contributes.retain(|kind, _| {
                matches!(
                    kind.as_str(),
                    "languages"
                        | "keybindings"
                        | "grammars"
                        | "snippets"
                        | "themes"
                        | "iconThemes"
                        | "productIconThemes"
                )
            });
        }
    }
    serde_json::to_string(&manifest).map_err(|error| error.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RendererClientDeclaration {
    api_version: u32,
    entry: String,
    digest: String,
    style: String,
    style_digest: String,
    source_digest: String,
}

fn renderer_client(
    runtime_id: &str,
    manifest: &str,
) -> Result<Option<ExtensionRendererClient>, String> {
    let manifest: serde_json::Value = serde_json::from_str(manifest)
        .map_err(|_| "Product editor manifest is invalid".to_string())?;
    let Some(declaration) = manifest
        .get("ashRuntime")
        .and_then(|runtime| runtime.get("client"))
    else {
        return Ok(None);
    };
    let client: RendererClientDeclaration = serde_json::from_value(declaration.clone())
        .map_err(|_| "Product editor client declaration is invalid".to_string())?;
    if client.api_version != 1
        || !valid_client_path(&client.entry)
        || !valid_client_path(&client.style)
        || !valid_client_digest(&client.digest)
        || !valid_client_digest(&client.style_digest)
        || !valid_client_digest(&client.source_digest)
    {
        return Err("Product editor client declaration exceeds its contract".into());
    }
    Ok(Some(ExtensionRendererClient {
        runtime_id: runtime_id.to_string(),
        api_version: client.api_version,
        entry: client.entry,
        digest: client.digest,
        style: client.style,
        style_digest: client.style_digest,
        source_digest: client.source_digest,
    }))
}

fn valid_client_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && !path.chars().any(|character| {
            character.is_control() || matches!(character, '\\' | ':' | '?' | '#' | '%')
        })
        && path
            .split('/')
            .all(|segment| !matches!(segment, "" | "." | ".."))
}

fn valid_client_digest(digest: &str) -> bool {
    digest.strip_prefix("sha256:").is_some_and(|value| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

/// Keeps Plugin and Extensions declarative Extension authorities independent and composable.
pub(super) struct CombinedExtensionSourceProvider {
    providers: Vec<Arc<dyn DynamicExtensionSourceProvider>>,
    state: Mutex<ProjectionState>,
}

impl CombinedExtensionSourceProvider {
    pub(super) fn new(providers: Vec<Arc<dyn DynamicExtensionSourceProvider>>) -> Self {
        Self {
            providers,
            state: Mutex::new(ProjectionState::default()),
        }
    }
}

impl DynamicExtensionSourceProvider for CombinedExtensionSourceProvider {
    fn snapshot(&self) -> Result<DynamicExtensionSourceSnapshot, String> {
        let mut packages = Vec::new();
        let mut diagnostics = Vec::new();
        let mut fingerprint = Vec::new();
        for provider in &self.providers {
            let snapshot = match provider.snapshot() {
                Ok(snapshot) => snapshot,
                Err(message) => {
                    diagnostics.push(ExtensionDiagnostic {
                        source: "dynamic".into(),
                        subject: None,
                        code: ExtensionDiagnosticCode::SourceUnavailable,
                        message: message.chars().take(512).collect(),
                    });
                    continue;
                }
            };
            diagnostics.extend(snapshot.diagnostics);
            fingerprint.push(snapshot.generation.to_string());
            for package in snapshot.packages {
                fingerprint.push(format!("{}\0{}", package.subject, package.path.display()));
                packages.push(package);
            }
        }
        fingerprint.extend(
            diagnostics
                .iter()
                .map(|diagnostic| format!("{diagnostic:?}")),
        );
        // Host-prepared built-ins precede authorities; explicit development user packages
        // cannot replace an authority-selected package or acquire built-in provenance.
        packages.sort_by_key(|package| match package.kind {
            ExtensionRootKind::BuiltIn => 0,
            ExtensionRootKind::Plugin | ExtensionRootKind::Registry => 1,
            ExtensionRootKind::User => 2,
        });
        let generation = next_generation(&self.state, fingerprint)?;
        Ok(DynamicExtensionSourceSnapshot {
            generation,
            packages,
            diagnostics,
        })
    }
}

fn next_generation(
    state: &Mutex<ProjectionState>,
    fingerprint: Vec<String>,
) -> Result<u64, String> {
    let mut state = state
        .lock()
        .map_err(|_| "Extensions Extension projection lock poisoned".to_string())?;
    if state.fingerprint != fingerprint {
        state.fingerprint = fingerprint;
        state.generation = state
            .generation
            .checked_add(1)
            .ok_or_else(|| "Extensions Extension projection generation exhausted".to_string())?;
    }
    Ok(state.generation.max(1))
}

#[cfg(test)]
#[path = "extension_packages_extension_sources_tests.rs"]
mod tests;
