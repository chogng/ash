use super::*;
use std::fs;

fn package(root: &Path, body: &str) {
    fs::create_dir_all(root.join(".ash-plugin")).unwrap();
    fs::create_dir_all(root.join("skills/review")).unwrap();
    fs::write(root.join("skills/review/SKILL.md"), body).unwrap();
    fs::write(
        root.join(".ash-plugin/plugin.json"),
        br#"{
          "schemaVersion": 1,
          "id": "acme/review",
          "version": "1.2.0",
          "displayName": "Acme Review",
          "compatibility": {"ash": ">=0.1.0"},
          "contributions": {"skills": [{"id": "review", "path": "skills/review"}]},
          "permissions": []
        }"#,
    )
    .unwrap();
}

#[test]
fn local_install_promotes_an_exact_immutable_object_and_is_idempotent() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    package(&source, "# Review");
    let local = LocalPluginPackage::load(&source).unwrap();
    let store = PluginPackageStore::open(temporary.path().join("store")).unwrap();

    let first = store.install_local(&local).unwrap();
    let second = store.install_local(&local).unwrap();

    assert_eq!(first, second);
    assert_eq!(store.read(&first).unwrap().package_digest(), &first.digest);
    assert!(
        fs::read_dir(temporary.path().join("store/staging"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn source_mutation_after_discovery_installs_the_latest_stable_snapshot() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    package(&source, "# Review");
    let local = LocalPluginPackage::load(&source).unwrap();
    let discovered_digest = local.package_digest().clone();
    fs::write(source.join("skills/review/SKILL.md"), "# Changed").unwrap();
    let store = PluginPackageStore::open(temporary.path().join("store")).unwrap();

    let installed = store.install_local(&local).unwrap();
    let activated = store.activate(&installed).unwrap();

    assert_ne!(installed.digest, discovered_digest);
    assert_eq!(
        activated
            .read_utf8_file(
                &crate::PluginPath::new("skills/review/SKILL.md").unwrap(),
                1024,
            )
            .unwrap(),
        "# Changed"
    );
}

#[test]
fn concurrent_installs_converge_on_one_immutable_object() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    package(&source, "# Review");
    let local = LocalPluginPackage::load(&source).unwrap();
    let store = PluginPackageStore::open(temporary.path().join("store")).unwrap();
    let first_store = store.clone();
    let first_package = local.clone();
    let second_store = store.clone();
    let second_package = local.clone();

    let first = std::thread::spawn(move || first_store.install_local(&first_package).unwrap());
    let second = std::thread::spawn(move || second_store.install_local(&second_package).unwrap());
    let first = first.join().unwrap();
    let second = second.join().unwrap();

    assert_eq!(first, second);
    assert_eq!(
        fs::read_dir(temporary.path().join("store/objects"))
            .unwrap()
            .count(),
        1
    );
    assert!(
        fs::read_dir(temporary.path().join("store/staging"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn source_change_during_snapshot_discards_the_attempt_and_retries() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    package(&source, "# Before");
    let local = LocalPluginPackage::load(&source).unwrap();
    let store = PluginPackageStore::open(temporary.path().join("store")).unwrap();
    let mut observed_attempts = 0;

    let installed = store
        .install_local_with_snapshot_observer(&local, |attempt, _| {
            observed_attempts = attempt;
            if attempt == 1 {
                fs::write(source.join("skills/review/SKILL.md"), "# After").unwrap();
            }
        })
        .unwrap();
    let activated = store.activate(&installed).unwrap();

    assert_eq!(observed_attempts, 2);
    assert_eq!(
        activated
            .read_utf8_file(
                &crate::PluginPath::new("skills/review/SKILL.md").unwrap(),
                1024,
            )
            .unwrap(),
        "# After"
    );
}

#[test]
fn source_identity_change_after_discovery_is_not_silently_installed() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    package(&source, "# Review");
    let local = LocalPluginPackage::load(&source).unwrap();
    let manifest_path = source.join(".ash-plugin/plugin.json");
    let manifest = fs::read_to_string(&manifest_path)
        .unwrap()
        .replace("1.2.0", "2.0.0");
    fs::write(manifest_path, manifest).unwrap();
    let store = PluginPackageStore::open(temporary.path().join("store")).unwrap();

    let error = store.install_local(&local).unwrap_err();

    assert_eq!(error.kind(), PluginErrorKind::PackageConflict);
    assert!(
        fs::read_dir(temporary.path().join("store/objects"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[cfg(any(unix, windows))]
#[test]
fn hard_link_introduced_after_validation_is_rejected_during_installation() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    package(&source, "# Review");
    let local = LocalPluginPackage::load(&source).unwrap();
    if !super::super::test_support::link_capability_available(
        fs::hard_link(
            source.join("skills/review/SKILL.md"),
            source.join("skills/review/linked.md"),
        ),
        "hard links",
    ) {
        return;
    }
    let store = PluginPackageStore::open(temporary.path().join("store")).unwrap();

    let error = store.install_local(&local).unwrap_err();

    assert_eq!(error.kind(), PluginErrorKind::PackageUnsafe);
    assert!(error.to_string().contains("hard-linked"));
    assert!(
        fs::read_dir(temporary.path().join("store/objects"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn activated_package_exposes_its_exact_immutable_object_root() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    package(&source, "# Review");
    let local = LocalPluginPackage::load(&source).unwrap();
    let store = PluginPackageStore::open(temporary.path().join("store")).unwrap();
    let installed = store.install_local(&local).unwrap();

    let activated = store.activate(&installed).unwrap();

    assert_eq!(
        activated.package_root(),
        temporary
            .path()
            .join("store/objects")
            .join(installed.digest.as_str().trim_start_matches("sha256:"))
            .canonicalize()
            .unwrap()
    );
}

#[test]
fn activated_package_keeps_its_snapshot_after_the_source_changes() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    package(&source, "# Installed");
    let local = LocalPluginPackage::load(&source).unwrap();
    let store = PluginPackageStore::open(temporary.path().join("store")).unwrap();
    let installed = store.install_local(&local).unwrap();
    let activated = store.activate(&installed).unwrap();

    fs::write(source.join("skills/review/SKILL.md"), "# Development").unwrap();

    assert_eq!(
        activated
            .read_utf8_file(
                &crate::PluginPath::new("skills/review/SKILL.md").unwrap(),
                1024,
            )
            .unwrap(),
        "# Installed"
    );
}

#[cfg(unix)]
#[test]
fn package_store_rejects_a_symlinked_objects_directory_during_install() {
    use std::os::unix::fs::symlink;

    let temporary = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    package(&source, "# Review");
    let local = LocalPluginPackage::load(&source).unwrap();
    let root = temporary.path().join("store");
    let store = PluginPackageStore::open(&root).unwrap();
    fs::remove_dir(root.join("objects")).unwrap();
    symlink(outside.path(), root.join("objects")).unwrap();

    let error = store.install_local(&local).unwrap_err();

    assert_eq!(error.kind(), PluginErrorKind::PackageUnsafe);
    assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
}

#[cfg(unix)]
#[test]
fn package_store_rejects_an_ancestor_symlink_during_object_removal() {
    use std::os::unix::fs::symlink;

    let temporary = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    package(&source, "# Review");
    let local = LocalPluginPackage::load(&source).unwrap();
    let root = temporary.path().join("store");
    let store = PluginPackageStore::open(&root).unwrap();
    let installed = store.install_local(&local).unwrap();
    fs::remove_dir_all(root.join("objects")).unwrap();
    symlink(outside.path(), root.join("objects")).unwrap();
    let outside_object = outside
        .path()
        .join(installed.digest.as_str().trim_start_matches("sha256:"));
    fs::create_dir(&outside_object).unwrap();
    fs::write(outside_object.join("sentinel"), b"outside").unwrap();

    let error = store.remove_object(&installed.digest).unwrap_err();

    assert_eq!(error.kind(), PluginErrorKind::PackageUnsafe);
    assert_eq!(
        fs::read(outside_object.join("sentinel")).unwrap(),
        b"outside"
    );
}

#[cfg(unix)]
#[test]
fn activated_package_rejects_an_internal_ancestor_symlink() {
    use std::os::unix::fs::symlink;

    let temporary = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    package(&source, "# Installed");
    let local = LocalPluginPackage::load(&source).unwrap();
    let store = PluginPackageStore::open(temporary.path().join("store")).unwrap();
    let installed = store.install_local(&local).unwrap();
    let activated = store.activate(&installed).unwrap();
    fs::remove_dir_all(activated.package_root().join("skills")).unwrap();
    symlink(outside.path(), activated.package_root().join("skills")).unwrap();
    fs::create_dir(outside.path().join("review")).unwrap();
    fs::write(outside.path().join("review/SKILL.md"), "# Outside").unwrap();

    let error = activated
        .read_utf8_file(
            &crate::PluginPath::new("skills/review/SKILL.md").unwrap(),
            1024,
        )
        .unwrap_err();

    assert_eq!(error.kind(), PluginErrorKind::PackageUnsafe);
}
