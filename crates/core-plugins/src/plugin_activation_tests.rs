use std::fs;

use tempfile::tempdir;

use crate::LocalPluginPackage;
use crate::PluginActivationSnapshot;
use crate::PluginPackageStore;

fn package(root: &std::path::Path, version: &str) -> LocalPluginPackage {
    fs::create_dir_all(root.join(".ash-plugin")).unwrap();
    fs::create_dir_all(root.join("mcp")).unwrap();
    fs::write(
        root.join(".ash-plugin/plugin.json"),
        format!(
            r#"{{
                "schemaVersion": 1,
                "id": "acme/review",
                "version": "{version}",
                "displayName": "Review",
                "compatibility": {{"ash": ">=0.1.0"}},
                "contributions": {{
                    "mcpServers": [{{"id": "review", "definition": "mcp/review.json"}}]
                }}
            }}"#
        ),
    )
    .unwrap();
    fs::write(root.join("mcp/review.json"), "{}").unwrap();
    LocalPluginPackage::load(root).unwrap()
}

#[test]
fn activation_resolves_immutable_objects_and_rejects_two_active_versions() {
    let source_one = tempdir().unwrap();
    let source_two = tempdir().unwrap();
    let store_root = tempdir().unwrap();
    let store = PluginPackageStore::open(store_root.path()).unwrap();
    let first = store
        .install_local(&package(source_one.path(), "1.0.0"))
        .unwrap();
    let second = store
        .install_local(&package(source_two.path(), "2.0.0"))
        .unwrap();

    let activation = PluginActivationSnapshot::resolve(1, &store, [first.clone()]).unwrap();
    assert_eq!(activation.generation(), 1);
    assert_eq!(
        activation.packages()[0].manifest().version.to_string(),
        "1.0.0"
    );
    assert!(PluginActivationSnapshot::resolve(2, &store, [first, second]).is_err());
}
