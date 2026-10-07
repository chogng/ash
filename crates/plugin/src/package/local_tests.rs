use super::*;
use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};

fn manifest(id: &str, version: &str) -> String {
    format!(
        r#"{{
            "schemaVersion": 1,
            "id": "{id}",
            "version": "{version}",
            "displayName": "Review",
            "compatibility": {{"ash": ">=0.1.0"}},
            "contributions": {{
                "skills": [{{"id": "review", "path": "skills/review"}}],
                "mcpServers": [{{"id": "review", "definition": "mcp/review.json"}}],
                "assets": [{{"id": "icon", "path": "assets/icon.txt"}}]
            }},
            "permissions": [
                {{"type": "process", "executable": "bin/review-server"}},
                {{"type": "directory", "access": "read"}},
                {{"type": "network", "hosts": ["api.example.com"]}}
            ],
            "credentialSlots": [
                {{"name": "token", "kind": "secretText", "requiredFor": ["mcp:review"]}}
            ]
        }}"#
    )
}

fn create_package(root: &Path, id: &str, version: &str, asset: &str) {
    for directory in [".ash-plugin", "skills/review", "mcp", "assets", "bin"] {
        fs::create_dir_all(root.join(directory)).unwrap();
    }
    fs::write(root.join(".ash-plugin/plugin.json"), manifest(id, version)).unwrap();
    fs::write(root.join("skills/review/SKILL.md"), "# Review").unwrap();
    fs::write(root.join("mcp/review.json"), "{}").unwrap();
    fs::write(root.join("assets/icon.txt"), asset).unwrap();
    fs::write(root.join("bin/review-server"), "binary").unwrap();
}

fn declare_editor_extension(root: &Path, entrypoint: &str) {
    let manifest_path = root.join(".ash-plugin/plugin.json");
    let mut value =
        serde_json::from_str::<serde_json::Value>(&fs::read_to_string(&manifest_path).unwrap())
            .unwrap();
    value["contributions"]["editorExtensions"] = serde_json::json!([{
        "id": "review-runtime",
        "entrypoint": entrypoint,
        "runtime": "hostRpc",
                    "runtimeApiVersion": 1,
        "activationEvents": [
            {"type": "onCommand", "id": "acme.review.run"}
        ],
        "capabilities": ["command"]
    }]);
    value["permissions"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({"type": "process", "executable": entrypoint}));
    fs::write(manifest_path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
}

fn declare_declarative_extension(root: &Path, path: &str) {
    let manifest_path = root.join(".ash-plugin/plugin.json");
    let mut value =
        serde_json::from_str::<serde_json::Value>(&fs::read_to_string(&manifest_path).unwrap())
            .unwrap();
    value["contributions"]["declarativeExtensions"] = serde_json::json!([{
        "id": "review-theme",
        "path": path
    }]);
    fs::write(manifest_path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
}

#[test]
fn exact_local_package_loads_with_content_and_manifest_digests() {
    let directory = TestDirectory::new();
    create_package(directory.path(), "acme/code-review", "1.2.3", "icon");

    let package = LocalPluginPackage::load(directory.path()).unwrap();

    assert_eq!(package.manifest().id.as_str(), "acme/code-review");
    assert_eq!(package.manifest().version.to_string(), "1.2.3");
    assert_ne!(package.package_digest(), package.manifest_digest());
    assert_eq!(package.stats().file_count, 5);
    assert!(package.stats().total_bytes > 0);
    assert_eq!(
        package.source(),
        &PluginPackageSource::LocalDevelopment {
            canonical_path: directory.path().canonicalize().unwrap()
        }
    );
}

#[test]
fn normalized_package_digest_is_root_independent_and_content_sensitive() {
    let first = TestDirectory::new();
    let second = TestDirectory::new();
    create_package(first.path(), "acme/review", "1.0.0", "same");
    create_package(second.path(), "acme/review", "1.0.0", "same");

    let first_digest = LocalPluginPackage::load(first.path())
        .unwrap()
        .package_digest()
        .clone();
    let second_digest = LocalPluginPackage::load(second.path())
        .unwrap()
        .package_digest()
        .clone();
    assert_eq!(first_digest, second_digest);

    fs::write(second.path().join("assets/icon.txt"), "changed").unwrap();
    assert_ne!(
        first_digest,
        *LocalPluginPackage::load(second.path())
            .unwrap()
            .package_digest()
    );
}

#[test]
fn marketplace_digest_is_explicit_and_does_not_change_legacy_local_identity() {
    let directory = TestDirectory::new();
    create_package(directory.path(), "acme/review", "1.0.0", "same");

    let legacy = LocalPluginPackage::load(directory.path()).unwrap();
    let marketplace = LocalPluginPackage::load_with_digest_algorithm(
        directory.path(),
        PluginPackageDigestAlgorithm::MarketplaceV1,
    )
    .unwrap();

    assert_eq!(
        legacy.digest_algorithm(),
        PluginPackageDigestAlgorithm::LegacyAshV1
    );
    assert_eq!(
        marketplace.digest_algorithm(),
        PluginPackageDigestAlgorithm::MarketplaceV1
    );
    assert_ne!(legacy.package_digest(), marketplace.package_digest());
    assert_eq!(legacy.manifest(), marketplace.manifest());
}

#[test]
fn missing_or_wrong_type_contribution_fails_the_whole_package() {
    let directory = TestDirectory::new();
    create_package(directory.path(), "acme/review", "1.0.0", "icon");
    fs::remove_file(directory.path().join("skills/review/SKILL.md")).unwrap();

    let error = LocalPluginPackage::load(directory.path()).unwrap_err();

    assert_eq!(error.kind(), PluginErrorKind::ContributionInvalid);
    assert!(error.to_string().contains("SKILL.md"));
}

#[test]
fn editor_extension_entrypoint_must_be_a_regular_contained_package_file() {
    let directory = TestDirectory::new();
    create_package(directory.path(), "acme/review", "1.0.0", "icon");
    declare_editor_extension(directory.path(), "extension/review-host");
    fs::create_dir_all(directory.path().join("extension/review-host")).unwrap();

    let error = LocalPluginPackage::load(directory.path()).unwrap_err();

    assert_eq!(error.kind(), PluginErrorKind::ContributionInvalid);
    assert!(error.to_string().contains("Editor Extension entrypoint"));

    fs::remove_dir(directory.path().join("extension/review-host")).unwrap();
    fs::write(
        directory.path().join("extension/review-host"),
        "host program",
    )
    .unwrap();
    let package = LocalPluginPackage::load(directory.path()).unwrap();
    assert_eq!(package.manifest().contributions.editor_extensions.len(), 1);
}

#[test]
fn declarative_extension_must_be_a_directory_with_a_package_manifest() {
    let directory = TestDirectory::new();
    create_package(directory.path(), "acme/review", "1.0.0", "icon");
    declare_declarative_extension(directory.path(), "extensions/review-theme");
    fs::create_dir_all(directory.path().join("extensions/review-theme")).unwrap();

    let error = LocalPluginPackage::load(directory.path()).unwrap_err();

    assert_eq!(error.kind(), PluginErrorKind::ContributionInvalid);
    assert!(error.to_string().contains("declarative Extension manifest"));

    fs::write(
        directory
            .path()
            .join("extensions/review-theme/package.json"),
        r#"{"name":"review-theme","publisher":"acme","version":"1.0.0"}"#,
    )
    .unwrap();
    let package = LocalPluginPackage::load(directory.path()).unwrap();
    assert_eq!(
        package
            .manifest()
            .contributions
            .declarative_extensions
            .len(),
        1
    );
}

#[cfg(unix)]
#[test]
fn symbolic_links_are_rejected_even_when_they_currently_point_inside_the_root() {
    use std::os::unix::fs::symlink;

    let directory = TestDirectory::new();
    create_package(directory.path(), "acme/review", "1.0.0", "icon");
    if !super::super::test_support::link_capability_available(
        symlink(
            directory.path().join("assets/icon.txt"),
            directory.path().join("assets/linked.txt"),
        ),
        "symbolic links",
    ) {
        return;
    }

    let error = LocalPluginPackage::load(directory.path()).unwrap_err();

    assert_eq!(error.kind(), PluginErrorKind::PackageUnsafe);
    assert!(error.to_string().contains("symbolic link"));
}

#[cfg(any(unix, windows))]
#[test]
fn local_discovery_leaves_hard_link_policy_to_installation() {
    let directory = TestDirectory::new();
    create_package(directory.path(), "acme/review", "1.0.0", "icon");
    if !super::super::test_support::link_capability_available(
        fs::hard_link(
            directory.path().join("assets/icon.txt"),
            directory.path().join("assets/linked.txt"),
        ),
        "hard links",
    ) {
        return;
    }

    let package = LocalPluginPackage::load(directory.path()).unwrap();

    assert_eq!(package.stats().file_count, 6);
}

#[test]
fn filesystem_names_that_cannot_be_canonical_plugin_paths_are_rejected() {
    let directory = TestDirectory::new();
    create_package(directory.path(), "acme/review", "1.0.0", "icon");
    fs::write(directory.path().join("assets/技能.txt"), "ambiguous").unwrap();

    let error = LocalPluginPackage::load(directory.path()).unwrap_err();

    assert_eq!(error.kind(), PluginErrorKind::PackageUnsafe);
    assert!(error.to_string().contains("unsafe package path"));
}

#[test]
fn local_catalog_lists_and_reads_exact_versions_in_stable_order() {
    let directory = TestDirectory::new();
    create_package(
        &directory.path().join("second"),
        "acme/review",
        "2.0.0",
        "two",
    );
    create_package(
        &directory.path().join("first"),
        "acme/review",
        "1.0.0",
        "one",
    );
    fs::create_dir_all(directory.path().join("unrelated")).unwrap();

    let catalog = LocalPluginCatalog::discover(directory.path()).unwrap();

    assert_eq!(catalog.list().len(), 2);
    assert_eq!(catalog.list()[0].manifest().version.to_string(), "1.0.0");
    assert!(
        catalog
            .read(
                &PluginPackageId::new("acme/review").unwrap(),
                &PluginVersion::new("2.0.0").unwrap()
            )
            .is_some()
    );
}

#[test]
fn local_catalog_rejects_ambiguous_exact_versions() {
    let directory = TestDirectory::new();
    create_package(
        &directory.path().join("first"),
        "acme/review",
        "1.0.0",
        "one",
    );
    create_package(
        &directory.path().join("second"),
        "acme/review",
        "1.0.0",
        "different",
    );

    let error = LocalPluginCatalog::discover(directory.path()).unwrap_err();

    assert_eq!(error.kind(), PluginErrorKind::PackageConflict);
    assert!(error.to_string().contains("acme/review 1.0.0"));
}

static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);

struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    fn new() -> Self {
        let sequence = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ash-plugin-tests-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
