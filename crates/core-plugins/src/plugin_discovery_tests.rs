use super::*;
use std::fs;

fn package(root: &std::path::Path) {
    fs::create_dir_all(root.join(".ash-plugin")).unwrap();
    fs::create_dir_all(root.join("skills/review")).unwrap();
    fs::write(root.join("skills/review/SKILL.md"), "# Review").unwrap();
    fs::write(
        root.join(".ash-plugin/plugin.json"),
        br#"{
          "schemaVersion": 1,
          "id": "acme/review",
          "version": "1.2.0",
          "displayName": "Acme Review",
          "description": "Review repository changes",
          "compatibility": {"ash": ">=0.1.0"},
          "contributions": {"skills": [{"id": "review", "path": "skills/review"}]},
          "permissions": []
        }"#,
    )
    .unwrap();
}

#[test]
fn validated_local_catalog_projects_without_becoming_executable() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("review");
    package(&root);
    let catalog = LocalPluginCatalog::discover(temporary.path()).unwrap();

    let snapshot = project_local_plugin_discovery(5, &catalog, &BTreeSet::new()).unwrap();

    assert_eq!(snapshot.generation(), 5);
    assert_eq!(snapshot.candidates().len(), 1);
    assert_eq!(snapshot.candidates()[0].action(), DiscoveryAction::Install);
}
