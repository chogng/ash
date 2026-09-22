use std::collections::BTreeSet;
use std::path::Component;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use ash_core_plugins::CapabilityKind;
use ash_core_plugins::LocalCapabilitySource;
use ash_core_plugins::PluginsManager;
use ash_extensions::DynamicExtensionPackageSource;
use ash_extensions::DynamicExtensionSourceProvider;
use ash_extensions::DynamicExtensionSourceSnapshot;
use serde::Deserialize;

const MAXIMUM_PORTABLE_THEME_MANIFEST_BYTES: u64 = 64 * 1024;
const MAXIMUM_PORTABLE_THEMES: usize = 128;

/// Projects installed Marketplace declarative editor assets into the Extension catalog.
pub(super) struct MarketplaceExtensionSourceProvider {
    manager: Arc<PluginsManager>,
    state: Mutex<ProjectionState>,
}

#[derive(Default)]
struct ProjectionState {
    fingerprint: Vec<String>,
    generation: u64,
}

impl MarketplaceExtensionSourceProvider {
    pub(super) fn new(manager: Arc<PluginsManager>) -> Self {
        Self {
            manager,
            state: Mutex::new(ProjectionState::default()),
        }
    }
}

impl DynamicExtensionSourceProvider for MarketplaceExtensionSourceProvider {
    fn snapshot(&self) -> Result<DynamicExtensionSourceSnapshot, String> {
        let mut sources = self
            .manager
            .local_capability_sources(CapabilityKind::Language)
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|source| {
                let manifest = normalized_language_manifest(&source)?;
                Ok((source, Some(manifest)))
            })
            .collect::<Result<Vec<_>, String>>()?;
        for source in self
            .manager
            .local_capability_sources(CapabilityKind::Theme)
            .map_err(|error| error.to_string())?
        {
            let manifest = normalized_theme_manifest(&source)?;
            sources.push((source, Some(manifest)));
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
        let fingerprint = sources
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
        let generation = next_generation(&self.state, fingerprint)?;
        let packages = sources
            .into_iter()
            .map(|(source, normalized_manifest)| {
                let subject = format!("{}:{}", source.package().id, source.id());
                match normalized_manifest {
                    Some(manifest) => DynamicExtensionPackageSource::marketplace_with_manifest(
                        subject,
                        source.host_path(),
                        manifest,
                    ),
                    None => DynamicExtensionPackageSource::marketplace(subject, source.host_path()),
                }
            })
            .collect();
        Ok(DynamicExtensionSourceSnapshot {
            generation,
            packages,
        })
    }
}

fn normalized_language_manifest(source: &LocalCapabilitySource) -> Result<String, String> {
    let path = source.host_path().join("package.json");
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|_| "Marketplace language manifest is unavailable".to_string())?;
    if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
        return Err("Marketplace language manifest exceeds its file contract".into());
    }
    let mut manifest: serde_json::Map<String, serde_json::Value> = serde_json::from_slice(
        &std::fs::read(path)
            .map_err(|_| "Marketplace language manifest is unavailable".to_string())?,
    )
    .map_err(|_| "Marketplace language manifest is invalid".to_string())?;
    let plugin = ash_plugin::PluginId::parse(&source.package().id)
        .map_err(|_| "Marketplace language package identity is invalid".to_string())?;
    manifest.insert("name".into(), plugin.plugin_name().into());
    manifest.insert("publisher".into(), plugin.marketplace().as_str().into());
    manifest.insert("version".into(), source.package().version.clone().into());
    serde_json::to_string(&manifest).map_err(|error| error.to_string())
}

fn normalized_theme_manifest(source: &LocalCapabilitySource) -> Result<String, String> {
    let path = source.host_path().join("package.json");
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|_| "Marketplace Theme manifest is unavailable".to_string())?;
    if !metadata.is_file() || metadata.len() > MAXIMUM_PORTABLE_THEME_MANIFEST_BYTES {
        return Err("Marketplace Theme manifest exceeds its file contract".into());
    }
    let manifest: PortableThemeManifest = serde_json::from_slice(
        &std::fs::read(path)
            .map_err(|_| "Marketplace Theme manifest is unavailable".to_string())?,
    )
    .map_err(|_| "Marketplace Theme manifest is invalid".to_string())?;
    if manifest.schema_version != 1
        || manifest.themes.is_empty()
        || manifest.themes.len() > MAXIMUM_PORTABLE_THEMES
    {
        return Err("Marketplace Theme manifest version is unsupported".into());
    }
    let plugin = ash_plugin::PluginId::parse(&source.package().id)
        .map_err(|_| "Marketplace Theme package identity is invalid".to_string())?;
    let publisher = plugin.marketplace().as_str();
    let name = plugin.plugin_name();
    let mut ids = BTreeSet::new();
    let mut paths = BTreeSet::new();
    let mut themes = Vec::new();
    for theme in manifest.themes {
        if theme.id.trim().is_empty()
            || theme.id.len() > 256
            || theme.display_name.trim().is_empty()
            || theme.display_name.len() > 512
            || !valid_theme_path(&theme.path)
            || !ids.insert(theme.id.clone())
            || !paths.insert(theme.path.clone())
        {
            return Err("Marketplace Theme declaration is invalid".into());
        }
        let theme_path = source.host_path().join(&theme.path);
        if !theme_path.is_file() {
            return Err("Marketplace Theme resource is unavailable".into());
        }
        themes.push(serde_json::json!({
            "id": theme.id,
            "label": theme.display_name,
            "uiTheme": theme.appearance.workbench_name(),
            "path": format!("./{}", theme.path),
        }));
    }
    serde_json::to_string(&serde_json::json!({
        "name": name,
        "publisher": publisher,
        "version": source.package().version,
        "displayName": name,
        "contributes": { "themes": themes },
    }))
    .map_err(|_| "Marketplace Theme manifest cannot be normalized".to_string())
}

fn valid_theme_path(value: &str) -> bool {
    let path = Path::new(value);
    value.starts_with("themes/")
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableThemeManifest {
    schema_version: u32,
    themes: Vec<PortableThemeDeclaration>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableThemeDeclaration {
    id: String,
    display_name: String,
    appearance: PortableThemeAppearance,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum PortableThemeAppearance {
    Dark,
    Light,
}

impl PortableThemeAppearance {
    fn workbench_name(&self) -> &'static str {
        match self {
            Self::Dark => "vs-dark",
            Self::Light => "vs",
        }
    }
}

/// Keeps Plugin and Marketplace declarative Extension authorities independent and composable.
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
        let mut fingerprint = Vec::new();
        for provider in &self.providers {
            let snapshot = provider.snapshot()?;
            fingerprint.push(snapshot.generation.to_string());
            for package in snapshot.packages {
                fingerprint.push(format!("{}\0{}", package.subject, package.path.display()));
                packages.push(package);
            }
        }
        let generation = next_generation(&self.state, fingerprint)?;
        Ok(DynamicExtensionSourceSnapshot {
            generation,
            packages,
        })
    }
}

fn next_generation(
    state: &Mutex<ProjectionState>,
    fingerprint: Vec<String>,
) -> Result<u64, String> {
    let mut state = state
        .lock()
        .map_err(|_| "Marketplace Extension projection lock poisoned".to_string())?;
    if state.fingerprint != fingerprint {
        state.fingerprint = fingerprint;
        state.generation = state
            .generation
            .checked_add(1)
            .ok_or_else(|| "Marketplace Extension projection generation exhausted".to_string())?;
    }
    Ok(state.generation.max(1))
}
