use std::collections::BTreeMap;
use std::sync::Arc;

use ash_core_plugins::CapabilityKind;
use ash_core_plugins::LocalCapabilitySource;
use ash_core_plugins::PluginsManager;
use ash_lsp_server_provider::DirectPackageLanguageServerProvider;
use ash_lsp_server_provider::LspServerProviders;
use ash_lsp_server_provider::ManagedNodeRuntime;
use ash_lsp_server_provider::NodePackageLanguageServerProvider;
use serde::Deserialize;

/// Composes installed Marketplace executable capabilities into language-server providers.
pub(crate) struct MarketplaceLanguageRuntime {
    manager: Arc<PluginsManager>,
    node: Option<ManagedNodeRuntime>,
    base: LspServerProviders,
}

impl MarketplaceLanguageRuntime {
    pub(crate) fn new(
        manager: Arc<PluginsManager>,
        node: Option<ManagedNodeRuntime>,
        base: LspServerProviders,
    ) -> Self {
        Self {
            manager,
            node,
            base,
        }
    }

    pub(crate) fn providers(&self) -> Result<LspServerProviders, String> {
        let assets = self
            .manager
            .local_capability_sources(CapabilityKind::Language)
            .map_err(|error| error.to_string())?;
        let executables = self
            .manager
            .local_capability_sources(CapabilityKind::Executable)
            .map_err(|error| error.to_string())?;
        let mut languages_by_digest = BTreeMap::new();
        for source in assets {
            languages_by_digest.insert(source.package().digest.clone(), language_ids(&source)?);
        }
        let mut providers = self.base.clone();
        for executable in executables {
            let Some(available_languages) = languages_by_digest.get(&executable.package().digest)
            else {
                continue;
            };
            let languages = executable.language_ids();
            if languages.is_empty()
                || languages
                    .iter()
                    .any(|language| !available_languages.contains(language))
            {
                return Err(format!(
                    "Marketplace language server '{}' has an invalid language route",
                    executable.id()
                ));
            }
            match executable.runtime().unwrap_or("node") {
                "node" => {
                    let node = self.node.clone().ok_or_else(|| {
                        format!(
                            "Marketplace language server '{}' requires the managed Node-compatible runtime",
                            executable.id()
                        )
                    })?;
                    let provider = NodePackageLanguageServerProvider::new(
                        executable.id(),
                        languages.iter().cloned(),
                        executable.host_path(),
                        node,
                    )
                    .map_err(|error| error.to_string())?;
                    providers
                        .register_packaged(provider)
                        .map_err(|error| error.to_string())?;
                }
                "direct" => {
                    let provider = DirectPackageLanguageServerProvider::new(
                        executable.id(),
                        languages.iter().cloned(),
                        executable.host_path(),
                    )
                    .map_err(|error| error.to_string())?;
                    providers
                        .register_packaged(provider)
                        .map_err(|error| error.to_string())?;
                }
                runtime => {
                    return Err(format!(
                        "Marketplace language server '{}' declares unsupported runtime '{runtime}'",
                        executable.id()
                    ));
                }
            }
        }
        Ok(providers)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LanguageExtensionManifest {
    contributes: LanguageContributions,
    #[serde(rename = "name")]
    _name: String,
    #[serde(rename = "publisher")]
    _publisher: String,
    #[serde(rename = "version")]
    _version: String,
    #[serde(default, rename = "displayName")]
    _display_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LanguageContributions {
    languages: Vec<LanguageContribution>,
    #[serde(default)]
    #[serde(rename = "grammars")]
    _grammars: Vec<serde_json::Value>,
    #[serde(default)]
    #[serde(rename = "snippets")]
    _snippets: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LanguageContribution {
    id: String,
    #[serde(default)]
    #[serde(rename = "aliases")]
    _aliases: Vec<String>,
    #[serde(default)]
    #[serde(rename = "extensions")]
    _extensions: Vec<String>,
    #[serde(default)]
    #[serde(rename = "firstLine")]
    _first_line: Option<String>,
    #[serde(default)]
    #[serde(rename = "configuration")]
    _configuration: Option<String>,
}

fn language_ids(source: &LocalCapabilitySource) -> Result<Vec<String>, String> {
    let manifest = std::fs::read(source.host_path().join("package.json"))
        .map_err(|_| "Marketplace language manifest is unavailable".to_string())?;
    let manifest: LanguageExtensionManifest = serde_json::from_slice(&manifest)
        .map_err(|_| "Marketplace language manifest is invalid".to_string())?;
    let mut languages = manifest
        .contributes
        .languages
        .into_iter()
        .map(|language| language.id)
        .collect::<Vec<_>>();
    languages.sort();
    languages.dedup();
    if languages.is_empty() || languages.iter().any(|language| language.trim().is_empty()) {
        return Err("Marketplace language manifest declares no valid language IDs".into());
    }
    Ok(languages)
}
