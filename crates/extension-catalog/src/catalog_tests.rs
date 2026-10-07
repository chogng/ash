use super::*;
use sha2::Digest;
use sha2::Sha256;
use std::fs;
use std::fs::File;
use std::sync::Arc;
use std::sync::Mutex;

#[test]
fn discovers_manifest_and_reads_a_grammar_resource() {
    let root = tempfile::tempdir().expect("extension root");
    let package = root.path().join("ash.demo");
    fs::create_dir_all(package.join("syntaxes")).expect("package directories");
    fs::write(
        package.join("package.json"),
        r#"{
            "name": "demo",
            "publisher": "ash",
            "version": "1.0.0",
            "displayName": "Demo",
            "contributes": {
                "grammars": [{
                    "language": "demo",
                    "scopeName": "source.demo",
                    "path": "./syntaxes/demo.tmLanguage.json"
                }]
            }
        }"#,
    )
    .expect("manifest");
    fs::write(
        package.join("syntaxes/demo.tmLanguage.json"),
        br#"{"scopeName":"source.demo","patterns":[]}"#,
    )
    .expect("grammar");

    let mut catalog = ExtensionCatalog::new(vec![ExtensionRoot::user(root.path())]);
    let snapshot = catalog.list(ExtensionCatalogReload::Refresh);

    assert_eq!(snapshot.extensions.len(), 1);
    assert_eq!(snapshot.extensions[0].id, "ash.demo");
    assert_eq!(
        snapshot.extensions[0].manifest_sha256,
        format!(
            "sha256:{:x}",
            Sha256::digest(snapshot.extensions[0].manifest_json.as_bytes())
        )
    );
    assert!(snapshot.diagnostics.is_empty());
    let resource = catalog
        .open_resource(
            snapshot.generation,
            "ash.demo",
            "syntaxes/demo.tmLanguage.json",
        )
        .expect("grammar resource");
    assert_eq!(resource.mime_type, "application/json");
    assert_eq!(
        resource.bytes,
        br#"{"scopeName":"source.demo","patterns":[]}"#
    );
}

#[test]
fn reports_invalid_manifests_without_registering_them() {
    let root = tempfile::tempdir().expect("extension root");
    let package = root.path().join("broken");
    fs::create_dir_all(&package).expect("package directory");
    fs::write(package.join("package.json"), r#"{"name":"demo"}"#).expect("manifest");

    let mut catalog = ExtensionCatalog::new(vec![ExtensionRoot::user(root.path())]);
    let snapshot = catalog.list(ExtensionCatalogReload::Refresh);

    assert!(snapshot.extensions.is_empty());
    assert_eq!(snapshot.diagnostics.len(), 1);
    assert_eq!(
        snapshot.diagnostics[0].code,
        ExtensionDiagnosticCode::InvalidManifest
    );
}

#[test]
fn rejects_paths_that_escape_the_package() {
    let root = tempfile::tempdir().expect("extension root");
    let package = root.path().join("ash.demo");
    fs::create_dir_all(&package).expect("package directory");
    fs::write(
        package.join("package.json"),
        r#"{"name":"demo","publisher":"ash","version":"1.0.0"}"#,
    )
    .expect("manifest");

    let mut catalog = ExtensionCatalog::new(vec![ExtensionRoot::user(root.path())]);
    let snapshot = catalog.list(ExtensionCatalogReload::Refresh);

    assert_eq!(
        catalog.open_resource(snapshot.generation, "ash.demo", "../package.json"),
        Err(ExtensionCatalogError::InvalidPath)
    );
}

#[test]
fn repeated_startup_refreshes_keep_in_flight_resource_reads_valid() {
    let root = tempfile::tempdir().expect("extension root");
    let package = write_package(root.path(), "1.0.0");
    fs::write(package.join("theme.json"), b"{}").expect("theme resource");
    fs::write(package.join("grammar.json"), b"[]").expect("grammar resource");
    let mut catalog = ExtensionCatalog::new(vec![ExtensionRoot::user(root.path())]);

    let themes = catalog.list(ExtensionCatalogReload::Refresh);
    let grammars = catalog.list(ExtensionCatalogReload::Refresh);

    assert_eq!(themes, grammars);
    assert_eq!(
        catalog
            .open_resource(themes.generation, "ash.demo", "theme.json")
            .expect("first startup consumer's resource")
            .bytes,
        b"{}"
    );
    assert_eq!(
        catalog
            .open_resource(grammars.generation, "ash.demo", "grammar.json")
            .expect("second startup consumer's resource")
            .bytes,
        b"[]"
    );
}

#[test]
fn unchanged_empty_catalog_keeps_its_generation() {
    let mut catalog = ExtensionCatalog::new(Vec::new());
    let first = catalog.list(ExtensionCatalogReload::Cached);

    assert!(first.generation > 0);
    assert_eq!(catalog.list(ExtensionCatalogReload::Refresh), first);
    assert_eq!(catalog.list(ExtensionCatalogReload::Cached), first);
}

#[test]
fn diagnostic_changes_advance_the_catalog_generation() {
    let root = tempfile::tempdir().expect("extension root");
    let mut catalog = ExtensionCatalog::new(vec![ExtensionRoot::user(root.path())]);
    let first = catalog.list(ExtensionCatalogReload::Refresh);
    let broken = root.path().join("broken");
    fs::create_dir_all(&broken).expect("broken package directory");
    fs::write(broken.join("package.json"), b"{}").expect("invalid manifest");

    let changed = catalog.list(ExtensionCatalogReload::Refresh);

    assert_eq!(changed.extensions, first.extensions);
    assert!(changed.generation > first.generation);
    assert_eq!(changed.diagnostics.len(), 1);
    assert_eq!(catalog.list(ExtensionCatalogReload::Refresh), changed);
}

#[test]
fn rejects_resource_reads_from_a_stale_catalog_generation() {
    let root = tempfile::tempdir().expect("extension root");
    let package = root.path().join("ash.demo");
    fs::create_dir_all(&package).expect("package directory");
    fs::write(
        package.join("package.json"),
        r#"{"name":"demo","publisher":"ash","version":"1.0.0"}"#,
    )
    .expect("manifest");
    fs::write(package.join("resource.json"), b"{}").expect("resource");

    let mut catalog = ExtensionCatalog::new(vec![ExtensionRoot::user(root.path())]);
    let stale = catalog.list(ExtensionCatalogReload::Refresh);
    fs::write(package.join("resource.json"), b"[]").expect("changed resource");
    let current = catalog.list(ExtensionCatalogReload::Refresh);

    assert!(current.generation > stale.generation);
    assert_eq!(
        current.extensions[0].manifest_sha256,
        stale.extensions[0].manifest_sha256
    );
    assert_ne!(
        current.extensions[0].package_sha256,
        stale.extensions[0].package_sha256
    );
    assert_eq!(
        catalog.open_resource(stale.generation, "ash.demo", "resource.json"),
        Err(ExtensionCatalogError::GenerationConflict)
    );
    assert_eq!(
        catalog
            .open_resource(current.generation, "ash.demo", "resource.json")
            .expect("changed resource")
            .bytes,
        b"[]"
    );
}

#[test]
fn freezes_package_resources_and_digest_until_refresh() {
    let root = tempfile::tempdir().expect("extension root");
    let package = write_package(root.path(), "1.0.0");
    let resource_path = package.join("resource.json");
    fs::write(&resource_path, br#"{"value":"old"}"#).expect("old resource");

    let mut catalog = ExtensionCatalog::new(vec![ExtensionRoot::user(root.path())]);
    let first = catalog.list(ExtensionCatalogReload::Refresh);
    let first_digest = first.extensions[0].package_sha256.clone();
    let unchanged = catalog.list(ExtensionCatalogReload::Refresh);
    assert_eq!(unchanged.generation, first.generation);
    assert_eq!(unchanged.extensions[0].package_sha256, first_digest);
    write_manifest(&package, "2.0.0");
    fs::write(&resource_path, br#"{"value":"new"}"#).expect("new resource");

    let frozen_manifest = catalog
        .open_resource(unchanged.generation, "ash.demo", "package.json")
        .expect("frozen manifest");
    assert_eq!(
        frozen_manifest.bytes,
        br#"{"name":"demo","publisher":"ash","version":"1.0.0"}"#
    );
    let frozen = catalog
        .open_resource(unchanged.generation, "ash.demo", "resource.json")
        .expect("frozen resource");
    assert_eq!(frozen.bytes, br#"{"value":"old"}"#);

    let second = catalog.list(ExtensionCatalogReload::Refresh);
    assert_eq!(second.extensions[0].version, "2.0.0");
    assert_ne!(second.extensions[0].package_sha256, first_digest);
    let refreshed = catalog
        .open_resource(second.generation, "ash.demo", "resource.json")
        .expect("refreshed resource");
    assert_eq!(refreshed.bytes, br#"{"value":"new"}"#);
    assert_eq!(
        catalog.open_resource(unchanged.generation, "ash.demo", "resource.json"),
        Err(ExtensionCatalogError::GenerationConflict)
    );
}

#[test]
fn rejects_a_package_with_an_oversized_file() {
    let root = tempfile::tempdir().expect("extension root");
    let package = write_package(root.path(), "1.0.0");
    let file = File::create(package.join("oversized.bin")).expect("oversized resource");
    file.set_len(crate::package::MAX_PACKAGE_FILE_BYTES as u64 + 1)
        .expect("oversized resource length");

    let mut catalog = ExtensionCatalog::new(vec![ExtensionRoot::user(root.path())]);
    let snapshot = catalog.list(ExtensionCatalogReload::Refresh);

    assert!(snapshot.extensions.is_empty());
    assert_eq!(snapshot.diagnostics.len(), 1);
    assert_eq!(
        snapshot.diagnostics[0].code,
        ExtensionDiagnosticCode::ResourceTooLarge
    );
}

#[cfg(any(unix, windows))]
#[test]
fn rejects_a_package_with_a_symbolic_link() {
    let root = tempfile::tempdir().expect("extension root");
    let package = write_package(root.path(), "1.0.0");
    let outside = root.path().join("outside.json");
    fs::write(&outside, b"{}").expect("outside resource");
    if let Err(error) = create_file_symlink(&outside, &package.join("linked.json")) {
        if cfg!(windows)
            && (error.kind() == std::io::ErrorKind::PermissionDenied
                || error.raw_os_error() == Some(1_314))
        {
            return;
        }
        panic!("resource symlink: {error}");
    }

    let mut catalog = ExtensionCatalog::new(vec![ExtensionRoot::user(root.path())]);
    let snapshot = catalog.list(ExtensionCatalogReload::Refresh);

    assert!(snapshot.extensions.is_empty());
    assert_eq!(snapshot.diagnostics.len(), 1);
    assert_eq!(
        snapshot.diagnostics[0].code,
        ExtensionDiagnosticCode::PathEscapesRoot
    );
}

#[test]
fn keeps_the_first_root_when_extension_ids_conflict() {
    let built_in = tempfile::tempdir().expect("built-in extension root");
    let user = tempfile::tempdir().expect("user extension root");
    let _ = write_package(built_in.path(), "1.0.0");
    let _ = write_package(user.path(), "2.0.0");

    let mut catalog = ExtensionCatalog::new(vec![
        ExtensionRoot::built_in(built_in.path()),
        ExtensionRoot::user(user.path()),
    ]);
    let snapshot = catalog.list(ExtensionCatalogReload::Refresh);

    assert_eq!(snapshot.extensions.len(), 1);
    assert_eq!(snapshot.extensions[0].version, "1.0.0");
    assert_eq!(
        snapshot.extensions[0].source_kind,
        ExtensionSourceKind::BuiltIn
    );
    assert_eq!(snapshot.diagnostics.len(), 1);
    assert_eq!(
        snapshot.diagnostics[0].code,
        ExtensionDiagnosticCode::DuplicateExtension
    );
}

#[test]
fn authority_generation_changes_preserve_unchanged_extension_contents() {
    let root = tempfile::tempdir().expect("plugin package parent");
    let package = write_package(root.path(), "1.0.0");
    fs::write(package.join("resource.json"), b"{}").expect("resource");
    let sources = vec![DynamicExtensionPackageSource::plugin(
        "acme/review:demo",
        package,
    )];
    let provider = Arc::new(TestDynamicSourceProvider::new(1, sources.clone()));
    let mut catalog = ExtensionCatalog::new(Vec::new()).with_dynamic_sources(provider.clone());
    let first = catalog.list(ExtensionCatalogReload::Cached);

    provider.replace(2, sources);
    let unchanged = catalog.list(ExtensionCatalogReload::Cached);

    assert_eq!(unchanged, first);
    write_manifest(&root.path().join("ash.demo"), "2.0.0");
    assert_eq!(catalog.list(ExtensionCatalogReload::Cached), first);
    assert_eq!(
        catalog
            .open_resource(first.generation, "ash.demo", "resource.json")
            .expect("unchanged plugin resource")
            .bytes,
        b"{}"
    );
}

#[test]
fn plugin_authority_packages_precede_user_roots_and_refresh_on_generation_change() {
    let plugin_root = tempfile::tempdir().expect("plugin package parent");
    let plugin_package = write_package(plugin_root.path(), "2.0.0");
    let user_root = tempfile::tempdir().expect("user extension root");
    let _ = write_package(user_root.path(), "3.0.0");
    let provider = Arc::new(TestDynamicSourceProvider::new(
        1,
        vec![DynamicExtensionPackageSource::plugin(
            "acme/review:demo",
            plugin_package,
        )],
    ));
    let mut catalog = ExtensionCatalog::new(vec![ExtensionRoot::user(user_root.path())])
        .with_dynamic_sources(provider.clone());

    let plugin_snapshot = catalog.list(ExtensionCatalogReload::Cached);

    assert_eq!(plugin_snapshot.extensions.len(), 1);
    assert_eq!(plugin_snapshot.extensions[0].version, "2.0.0");
    assert_eq!(
        plugin_snapshot.extensions[0].source_kind,
        ExtensionSourceKind::Plugin
    );
    assert_eq!(plugin_snapshot.diagnostics.len(), 1);

    provider.replace(2, Vec::new());
    let user_snapshot = catalog.list(ExtensionCatalogReload::Cached);

    assert!(user_snapshot.generation > plugin_snapshot.generation);
    assert_eq!(user_snapshot.extensions[0].version, "3.0.0");
    assert_eq!(
        user_snapshot.extensions[0].source_kind,
        ExtensionSourceKind::User
    );
    assert!(user_snapshot.diagnostics.is_empty());
}

struct TestDynamicSourceProvider {
    snapshot: Mutex<DynamicExtensionSourceSnapshot>,
}

impl TestDynamicSourceProvider {
    fn new(generation: u64, packages: Vec<DynamicExtensionPackageSource>) -> Self {
        Self {
            snapshot: Mutex::new(DynamicExtensionSourceSnapshot {
                generation,
                packages,
            }),
        }
    }

    fn replace(&self, generation: u64, packages: Vec<DynamicExtensionPackageSource>) {
        *self.snapshot.lock().unwrap() = DynamicExtensionSourceSnapshot {
            generation,
            packages,
        };
    }
}

impl DynamicExtensionSourceProvider for TestDynamicSourceProvider {
    fn snapshot(&self) -> Result<DynamicExtensionSourceSnapshot, String> {
        Ok(self.snapshot.lock().unwrap().clone())
    }
}

fn write_package(root: &std::path::Path, version: &str) -> std::path::PathBuf {
    let package = root.join("ash.demo");
    fs::create_dir_all(&package).expect("package directory");
    write_manifest(&package, version);
    package
}

fn write_manifest(package: &std::path::Path, version: &str) {
    fs::write(
        package.join("package.json"),
        format!(r#"{{"name":"demo","publisher":"ash","version":"{version}"}}"#),
    )
    .expect("manifest");
}

#[cfg(unix)]
fn create_file_symlink(target: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_file_symlink(target: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
}
