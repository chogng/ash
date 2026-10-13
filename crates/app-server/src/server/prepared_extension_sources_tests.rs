use super::PreparedExtensionSourceProvider;
use ash_external_ext::packages::DynamicExtensionSourceProvider;
use ash_external_ext::packages::ExtensionPackages;
use ash_external_ext::packages::ExtensionPackagesError;
use ash_external_ext::packages::ExtensionPackagesReload;
use ash_external_ext::packages::ExtensionSourceKind;
use std::path::Path;
use std::sync::Arc;

fn write_package(root: &Path, snapshot: &str, source: &str) {
    let package = root.join("packages").join(snapshot);
    std::fs::create_dir_all(package.join("browser")).unwrap();
    std::fs::write(package.join("package.json"), r#"{"publisher":"test","name":"browser","version":"1.0.0","browser":"./browser/extension.js"}"#).unwrap();
    std::fs::write(package.join("browser/extension.js"), source).unwrap();
}

fn publish(root: &Path, built_in: &[String], user: &[String]) {
    std::fs::write(
        root.join("current.json"),
        serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"builtIn":built_in,"user":user}))
            .unwrap(),
    )
    .unwrap();
}

#[test]
fn prepared_extension_packages_refresh_without_rebinding_or_mutating_old_resources() {
    let root = tempfile::tempdir().unwrap();
    let first = "a".repeat(64);
    let second = "b".repeat(64);
    write_package(
        root.path(),
        &first,
        "export function activate() { return 'first'; }",
    );
    publish(root.path(), std::slice::from_ref(&first), &[]);
    let provider = Arc::new(PreparedExtensionSourceProvider::new(root.path().into()));
    let mut catalog = ExtensionPackages::new(Vec::new()).with_dynamic_sources(provider);
    let before = catalog.list(ExtensionPackagesReload::Cached);
    assert_eq!(
        before.extensions[0].source_kind,
        ExtensionSourceKind::BuiltIn
    );
    assert_eq!(catalog.list(ExtensionPackagesReload::Refresh), before);
    assert_eq!(
        catalog
            .open_resource(before.generation, "test.browser", "browser/extension.js")
            .unwrap()
            .bytes,
        b"export function activate() { return 'first'; }"
    );
    write_package(
        root.path(),
        &second,
        "export function activate() { return 'second'; }",
    );
    // Unpublished artifacts cannot change the live catalog.
    assert_eq!(catalog.list(ExtensionPackagesReload::Refresh), before);
    publish(root.path(), std::slice::from_ref(&second), &[]);
    let after = catalog.list(ExtensionPackagesReload::Cached);
    assert!(after.generation > before.generation);
    assert_eq!(
        catalog.open_resource(before.generation, "test.browser", "browser/extension.js"),
        Err(ExtensionPackagesError::GenerationConflict)
    );
    assert_eq!(
        catalog
            .open_resource(after.generation, "test.browser", "browser/extension.js")
            .unwrap()
            .bytes,
        b"export function activate() { return 'second'; }"
    );
    assert!(
        std::fs::read_to_string(
            root.path()
                .join("packages")
                .join(first)
                .join("browser/extension.js")
        )
        .unwrap()
        .contains("first")
    );
}

#[test]
fn prepared_extension_publication_rejects_paths_unknown_fields_and_new_schema() {
    let root = tempfile::tempdir().unwrap();
    let provider = PreparedExtensionSourceProvider::new(root.path().into());
    assert!(provider.snapshot().is_err());
    for invalid in [
        serde_json::json!({"schemaVersion":1,"builtIn":["../outside"],"user":[]}),
        serde_json::json!({"schemaVersion":2,"builtIn":[],"user":[]}),
        serde_json::json!({"schemaVersion":1,"builtIn":[],"user":[],"hostPath":"/outside"}),
        serde_json::json!({"schemaVersion":1,"builtIn":[],"user":[],"packageNames":{"a":"../outside"}}),
    ] {
        std::fs::write(
            root.path().join("current.json"),
            serde_json::to_vec(&invalid).unwrap(),
        )
        .unwrap();
        assert!(provider.snapshot().is_err());
    }
}

#[test]
fn explicitly_prepared_development_packages_keep_user_provenance() {
    let root = tempfile::tempdir().unwrap();
    let snapshot = "a".repeat(64);
    write_package(root.path(), &snapshot, "export function activate() {}");
    publish(root.path(), &[], &[snapshot]);
    let mut catalog = ExtensionPackages::new(Vec::new()).with_dynamic_sources(Arc::new(
        PreparedExtensionSourceProvider::new(root.path().into()),
    ));
    assert_eq!(
        catalog.list(ExtensionPackagesReload::Cached).extensions[0].source_kind,
        ExtensionSourceKind::User
    );
}
