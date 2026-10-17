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
use ash_external_ext::packages::ExtensionRootKind;

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
        for kind in [
            CapabilityKind::Language,
            CapabilityKind::Theme,
            CapabilityKind::EditorExtension,
        ] {
            let selected = match self.manager.local_capability_sources(kind) {
                Ok(selected) => selected,
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
                if self.policy.as_ref().is_some_and(|policy| {
                    !policy
                        .snapshot(source.package(), source.capability())
                        .enabled
                }) {
                    continue;
                }
                let manifest = normalized_extension_manifest(&source);
                match manifest {
                    Ok(manifest) => sources.push((source, manifest)),
                    Err(message) => diagnostics.push(ExtensionDiagnostic {
                        source: "extensions".into(),
                        subject: Some(
                            format!("{}:{}", source.package().id, source.id())
                                .chars()
                                .take(256)
                                .collect(),
                        ),
                        code: ExtensionDiagnosticCode::InvalidManifest,
                        message: message.chars().take(512).collect(),
                    }),
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
            .map(|(source, _)| {
                format!(
                    "{}\0{}\0{}\0{}",
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
            .map(|(source, normalized_manifest)| {
                let subject = format!("{}:{}", source.package().id, source.id());
                DynamicExtensionPackageSource::extension_packages_with_manifest(
                    subject,
                    source.host_path(),
                    normalized_manifest,
                )
            })
            .collect();
        Ok(DynamicExtensionSourceSnapshot {
            generation,
            packages,
            diagnostics,
        })
    }
}

fn normalized_extension_manifest(source: &LocalCapabilitySource) -> Result<String, String> {
    let path = source.host_path().join("package.json");
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
    manifest.insert("name".into(), plugin.plugin_name().into());
    manifest.insert("publisher".into(), plugin.source_id().as_str().into());
    manifest.insert("version".into(), source.package().version.clone().into());
    if source.kind() == CapabilityKind::EditorExtension {
        // Open VSX admission currently covers resources only. In particular, Ash's declarative
        // debugger command must not become a route from an ungranted VSIX to process execution.
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
