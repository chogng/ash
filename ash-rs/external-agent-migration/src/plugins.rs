use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value as JsonValue;

use crate::plan::ExternalPluginMarketplace;
use crate::plan::MarketplaceSource;

pub(crate) const KNOWN_MARKETPLACES_PATH: &str = ".claude/plugins/known_marketplaces.json";
const OFFICIAL_MARKETPLACE_NAME: &str = "claude-plugins-official";
const OFFICIAL_MARKETPLACE_REPO: &str = "anthropics/claude-plugins-official";
const CLAUDE_CODE_MARKETPLACE_NAME: &str = "claude-code-plugins";
const CLAUDE_CODE_MARKETPLACE_REPO: &str = "anthropics/claude-code";

/// Groups externally enabled plugins by marketplace and resolves marketplace sources.
///
/// Only marketplaces with at least one enabled plugin and a resolvable source are reported;
/// plugins on unknown marketplaces cannot be migrated deterministically. Whether a marketplace
/// or plugin can be installed into Ash stays with the caller's adapter.
pub(crate) fn claude_plugin_marketplaces(
    settings: &JsonValue,
    known_marketplaces: Option<&JsonValue>,
    external_agent_home: &Path,
    source_root: &Path,
) -> Vec<ExternalPluginMarketplace> {
    let enabled = enabled_plugins_by_marketplace(settings);
    if enabled.is_empty() {
        return Vec::new();
    }
    let sources = marketplace_sources(
        settings,
        known_marketplaces,
        external_agent_home,
        source_root,
        &enabled,
    );

    enabled
        .into_iter()
        .filter_map(|(marketplace, plugins)| {
            let source = sources.get(&marketplace).cloned().flatten()?;
            Some(ExternalPluginMarketplace {
                marketplace,
                plugins,
                source: Some(source),
            })
        })
        .collect()
}

fn enabled_plugins_by_marketplace(settings: &JsonValue) -> BTreeMap<String, Vec<String>> {
    let Some(enabled_plugins) = settings
        .get("enabledPlugins")
        .and_then(JsonValue::as_object)
    else {
        return BTreeMap::new();
    };

    let mut marketplaces = BTreeMap::new();
    for (plugin_key, enabled) in enabled_plugins {
        if !enabled.as_bool().unwrap_or(false) {
            continue;
        }
        let Some((plugin_name, marketplace_name)) = plugin_key.rsplit_once('@') else {
            continue;
        };
        if plugin_name.is_empty() || marketplace_name.is_empty() {
            continue;
        }
        marketplaces
            .entry(marketplace_name.to_string())
            .or_insert_with(Vec::new)
            .push(plugin_name.to_string());
    }
    for plugins in marketplaces.values_mut() {
        plugins.sort();
    }
    marketplaces
}

fn marketplace_sources(
    settings: &JsonValue,
    known_marketplaces: Option<&JsonValue>,
    external_agent_home: &Path,
    source_root: &Path,
    enabled: &BTreeMap<String, Vec<String>>,
) -> BTreeMap<String, Option<MarketplaceSource>> {
    let mut sources = known_marketplaces
        .and_then(JsonValue::as_object)
        .map(|known_marketplaces| {
            collect_marketplace_sources(known_marketplaces, external_agent_home)
        })
        .unwrap_or_default();

    if let Some(extra_known_marketplaces) = settings.get("extraKnownMarketplaces") {
        apply_extra_known_marketplaces(
            &mut sources,
            extra_known_marketplaces,
            known_marketplaces,
            external_agent_home,
            source_root,
        );
    }

    for (marketplace_name, marketplace_repo) in [
        (OFFICIAL_MARKETPLACE_NAME, OFFICIAL_MARKETPLACE_REPO),
        (CLAUDE_CODE_MARKETPLACE_NAME, CLAUDE_CODE_MARKETPLACE_REPO),
    ] {
        if enabled.contains_key(marketplace_name) && !sources.contains_key(marketplace_name) {
            sources.insert(
                marketplace_name.to_string(),
                Some(MarketplaceSource::GitHub {
                    repo: marketplace_repo.to_string(),
                    reference: None,
                }),
            );
        }
    }

    sources
}

fn apply_extra_known_marketplaces(
    sources: &mut BTreeMap<String, Option<MarketplaceSource>>,
    extra_known_marketplaces: &JsonValue,
    known_marketplaces: Option<&JsonValue>,
    external_agent_home: &Path,
    source_root: &Path,
) {
    let Some(extra_known_marketplaces) = extra_known_marketplaces.as_object() else {
        return;
    };
    let mut scoped_marketplaces = extra_known_marketplaces.clone();
    for (name, scoped_marketplace) in scoped_marketplaces.iter_mut() {
        sources.remove(name);
        let Some(known_marketplace) = known_marketplaces
            .and_then(JsonValue::as_object)
            .and_then(|known| known.get(name))
        else {
            continue;
        };
        if scoped_marketplace.get("source") != known_marketplace.get("source") {
            continue;
        }
        let Some(install_location) = known_marketplace
            .get("installLocation")
            .and_then(JsonValue::as_str)
        else {
            continue;
        };
        let install_location = Path::new(install_location);
        let install_location = if install_location.is_absolute() {
            install_location.to_path_buf()
        } else {
            external_agent_home.join(install_location)
        };
        let Some(scoped_object) = scoped_marketplace.as_object_mut() else {
            continue;
        };
        scoped_object.insert(
            "installLocation".to_string(),
            JsonValue::String(install_location.display().to_string()),
        );
    }
    sources.extend(collect_marketplace_sources(
        &scoped_marketplaces,
        source_root,
    ));
}

fn collect_marketplace_sources(
    marketplaces: &serde_json::Map<String, JsonValue>,
    source_root: &Path,
) -> BTreeMap<String, Option<MarketplaceSource>> {
    marketplaces
        .iter()
        .filter_map(|(name, value)| {
            let source = marketplace_source(value, source_root);
            Some((name.clone(), source))
        })
        .collect()
}

fn marketplace_source(value: &JsonValue, source_root: &Path) -> Option<MarketplaceSource> {
    let source_fields = if let Some(source) = value.get("source")
        && source.is_object()
    {
        source.as_object()?
    } else {
        value.as_object()?
    };
    let source_kind = source_fields
        .get("source")
        .and_then(JsonValue::as_str)
        .map(str::trim);
    let declared_source = match source_kind {
        Some("github") => source_fields.get("repo"),
        Some("git") => source_fields.get("url"),
        Some("directory" | "local") => source_fields.get("path"),
        Some("file" | "url" | "npm" | "settings") => None,
        Some(_) => source_fields.get("source"),
        None => source_fields
            .get("repo")
            .or_else(|| source_fields.get("url"))
            .or_else(|| source_fields.get("path"))
            .or_else(|| value.get("source")),
    }
    .and_then(JsonValue::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty());
    let reference = source_fields
        .get("ref")
        .or_else(|| value.get("ref"))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    if let Some(declared_source) = declared_source {
        if matches!(source_kind, Some("directory" | "local")) {
            let path = Path::new(declared_source);
            let path = if path.is_absolute() {
                path.to_path_buf()
            } else {
                source_root.join(path)
            };
            return Some(MarketplaceSource::Directory(path));
        }
        if source_kind.is_none() || source_kind.is_some_and(|kind| kind == "github") {
            return Some(MarketplaceSource::GitHub {
                repo: declared_source.to_string(),
                reference,
            });
        }
        if source_kind.is_some_and(|kind| kind == "git") {
            return Some(MarketplaceSource::Git {
                url: declared_source.to_string(),
                reference,
            });
        }
        return None;
    }

    let install_location = value
        .get("installLocation")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| {
            let path = Path::new(value);
            let path = if path.is_absolute() {
                path.to_path_buf()
            } else {
                source_root.join(path)
            };
            path.is_dir().then_some(path)
        })?;
    Some(MarketplaceSource::Directory(install_location))
}

#[cfg(test)]
#[path = "plugins_tests.rs"]
mod tests;
