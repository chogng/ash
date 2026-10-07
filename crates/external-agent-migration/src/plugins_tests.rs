use std::fs;
use std::path::Path;

use serde_json::json;
use tempfile::TempDir;

use crate::AgentImportLocation;
use crate::ImportItemKind;
use crate::plan::MarketplaceSource;
use crate::source::Source;

fn write(path: &Path, contents: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

#[test]
fn settings_without_enabled_plugins_yield_no_marketplaces() {
    let temp = TempDir::new().unwrap();
    let settings = json!({"enabledPlugins": {"a@b": false}});
    assert!(claude_plugin_marketplaces(&settings, temp.path(), temp.path()).is_empty());
}

#[test]
fn enabled_plugins_group_by_marketplace_with_known_registry_source() {
    let temp = TempDir::new().unwrap();
    let external_agent_home = temp.path().join(".claude");
    write(
        &external_agent_home.join("plugins/known_marketplaces.json"),
        r#"{
            "team": {"source": {"source": "github", "repo": "acme/team-plugins"}, "installLocation": "plugins/cache/team"},
            "local": {"source": {"source": "directory", "path": "./vendors/marketplace"}}
        }"#,
    );
    let settings = json!({
        "enabledPlugins": {
            "reviewer@team": true,
            "formatter@team": true,
            "fastedit@local": true,
            "stray@missing": true
        }
    });

    let marketplaces = claude_plugin_marketplaces(&settings, &external_agent_home, temp.path());
    assert_eq!(marketplaces.len(), 2);

    let team = marketplaces
        .iter()
        .find(|marketplace| marketplace.marketplace == "team")
        .unwrap();
    assert_eq!(team.plugins, vec!["formatter", "reviewer"]);
    assert_eq!(
        team.source,
        Some(MarketplaceSource::GitHub {
            repo: "acme/team-plugins".to_string(),
            reference: None,
        })
    );

    let local = marketplaces
        .iter()
        .find(|marketplace| marketplace.marketplace == "local")
        .unwrap();
    assert_eq!(
        local.source,
        // Registry-relative declared paths resolve against the external config directory.
        Some(MarketplaceSource::Directory(
            external_agent_home.join("./vendors/marketplace")
        ))
    );

    assert!(
        !marketplaces
            .iter()
            .any(|marketplace| marketplace.marketplace == "missing")
    );
}

#[test]
fn official_marketplace_source_falls_back_for_enabled_plugins() {
    let temp = TempDir::new().unwrap();
    let settings = json!({
        "enabledPlugins": {"_format@claude-plugins-official": true}
    });

    let marketplaces = claude_plugin_marketplaces(&settings, temp.path(), temp.path());
    assert_eq!(marketplaces.len(), 1);
    assert_eq!(
        marketplaces[0].source,
        Some(MarketplaceSource::GitHub {
            repo: "anthropics/claude-plugins-official".to_string(),
            reference: None,
        })
    );
}

#[test]
fn extra_known_marketplaces_override_registry_entries() {
    let temp = TempDir::new().unwrap();
    let external_agent_home = temp.path().join(".claude");
    write(
        &external_agent_home.join("plugins/known_marketplaces.json"),
        r#"{
            "team": {"source": {"source": "github", "repo": "acme/team-plugins"}, "installLocation": "plugins/cache/team"}
        }"#,
    );
    let settings = json!({
        "enabledPlugins": {"reviewer@team": true},
        "extraKnownMarketplaces": {
            "team": {"source": {"source": "github", "repo": "acme/other-plugins"}}
        }
    });

    let marketplaces = claude_plugin_marketplaces(&settings, &external_agent_home, temp.path());
    // A scoped entry whose declared source differs from the registry replaces the registry
    // declaration; the registry install location no longer applies.
    assert_eq!(marketplaces.len(), 1);
    assert_eq!(
        marketplaces[0].source,
        Some(MarketplaceSource::GitHub {
            repo: "acme/other-plugins".to_string(),
            reference: None,
        })
    );
}

#[test]
fn scoped_marketplace_without_declared_source_uses_install_location() {
    let temp = TempDir::new().unwrap();
    let external_agent_home = temp.path().join(".claude");
    let cache = external_agent_home.join("vendors/team");
    fs::create_dir_all(&cache).unwrap();
    write(
        &external_agent_home.join("plugins/known_marketplaces.json"),
        r#"{
            "team": {"source": {"source": "npm", "package": "@acme/team"}, "installLocation": "vendors/team"}
        }"#,
    );
    let settings = json!({
        "enabledPlugins": {"reviewer@team": true},
        "extraKnownMarketplaces": {
            "team": {"source": {"source": "npm", "package": "@acme/team"}}
        }
    });

    let marketplaces = claude_plugin_marketplaces(&settings, &external_agent_home, temp.path());
    assert_eq!(marketplaces.len(), 1);
    // npm sources carry no installable declaration, so the materialized directory is the source.
    assert_eq!(
        marketplaces[0].source,
        Some(MarketplaceSource::Directory(cache))
    );
}

#[test]
fn invalid_marketplace_registry_is_ignored() {
    let temp = TempDir::new().unwrap();
    let external_agent_home = temp.path().join(".claude");
    write(
        &external_agent_home.join("plugins/known_marketplaces.json"),
        "{broken",
    );
    let settings = json!({
        "enabledPlugins": {"reviewer@team": true}
    });

    // Without a resolvable marketplace source the enabled plugin cannot migrate.
    let marketplaces = claude_plugin_marketplaces(&settings, &external_agent_home, temp.path());
    assert!(marketplaces.is_empty());
}

fn claude_plugin_marketplaces(
    settings: &serde_json::Value,
    external_home: &Path,
    root: &Path,
) -> Vec<crate::ExternalPluginMarketplace> {
    let mut source = Source::new(AgentImportLocation::claude_user(root)).unwrap();
    let path = external_home.join("plugins/known_marketplaces.json");
    let registry = source.read(
        path.strip_prefix(root).unwrap(),
        ImportItemKind::Plugins,
        crate::settings::parse_json,
    );
    super::claude_plugin_marketplaces(
        settings,
        registry.as_ref().map(|document| &document.value),
        external_home,
        root,
    )
}
