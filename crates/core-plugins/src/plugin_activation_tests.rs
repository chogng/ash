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

#[test]
fn skill_roots_resolve_declared_contributions_inside_the_installed_object() {
    let source = tempdir().unwrap();
    let store_root = tempdir().unwrap();
    let local = package(source.path(), "1.0.0");
    let manifest_path = source.path().join(".ash-plugin/plugin.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["contributions"]["skills"] = serde_json::json!([
        {"id": "review", "path": "skills/review"}
    ]);
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    for name in ["review", "undeclared"] {
        fs::create_dir_all(source.path().join("skills").join(name)).unwrap();
        fs::write(
            source.path().join("skills").join(name).join("SKILL.md"),
            "# Skill",
        )
        .unwrap();
    }
    let store = PluginPackageStore::open(store_root.path()).unwrap();
    let installed = store
        .install_local(&LocalPluginPackage::load(source.path()).unwrap())
        .unwrap();
    assert_eq!(local.manifest().id, installed.id);
    let activation = PluginActivationSnapshot::resolve(1, &store, [installed]).unwrap();
    let roots = activation.skill_roots().unwrap();
    assert_eq!(roots.len(), 1);
    assert_eq!(
        roots[0].source_id(),
        "plugin-acme/review:skill-source:review"
    );
    assert_eq!(roots[0].skill_name, "review");
    assert!(
        roots[0]
            .path
            .starts_with(activation.packages()[0].package_root())
    );
    assert!(
        !roots[0]
            .path
            .starts_with(source.path().canonicalize().unwrap())
    );
    assert!(
        PluginActivationSnapshot::empty(2)
            .unwrap()
            .skill_roots()
            .unwrap()
            .is_empty()
    );
}
