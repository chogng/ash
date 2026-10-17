use super::discover_plugin_roots;
use std::fs;
use tempfile::tempdir;

#[test]
fn discovery_is_direct_ordered_and_does_not_read_manifest_content() {
    let root = tempdir().unwrap();
    for name in ["b", "a", "ordinary/nested"] {
        fs::create_dir_all(root.path().join(name).join(".ash-plugin")).unwrap();
    }
    assert_eq!(
        discover_plugin_roots(root.path()).unwrap(),
        vec![root.path().join("a"), root.path().join("b")]
    );
    fs::create_dir(root.path().join(".ash-plugin")).unwrap();
    assert_eq!(
        discover_plugin_roots(root.path()).unwrap(),
        vec![root.path().to_path_buf()]
    );
}

#[test]
fn malformed_marker_is_left_for_package_validation_and_missing_sources_fail() {
    let root = tempdir().unwrap();
    fs::write(root.path().join(".ash-plugin"), "invalid marker").unwrap();
    assert_eq!(
        discover_plugin_roots(root.path()).unwrap(),
        vec![root.path()]
    );
    assert_eq!(
        discover_plugin_roots(&root.path().join("missing"))
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::NotFound
    );
}
