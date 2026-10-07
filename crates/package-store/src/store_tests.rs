use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use tempfile::TempDir;

use super::PackageLease;
use super::PackageStore;
use super::acquire_package_lease_for_executable;
use super::package_build_id;

#[test]
fn package_build_id_preserves_existing_hash_for_nested_reordered_objects() {
    // This digest pins the existing package identity format, including JSON escaping,
    // Unicode, nested objects in arrays, and the separators around file identities.
    let identity: serde_json::Value = serde_json::from_str(
        r#"{"z":[{"β":"前\n\"\\","a":true},{"z":null,"a":[-3,1.5]}],"a":{"z":"last","a":"first"}}"#,
    )
    .unwrap();
    let reordered: serde_json::Value = serde_json::from_str(
        r#"{"a":{"a":"first","z":"last"},"z":[{"a":true,"β":"前\n\"\\"},{"a":[-3,1.5],"z":null}]}"#,
    )
    .unwrap();
    let files = BTreeMap::from([("artifact".to_string(), "0123456789abcdef".to_string())]);
    let expected = "sha256:8023fb146ce312b95eacb742c430d7898a20e55f7d31a7bafdb99ab4a2835dc2";

    assert_eq!(
        package_build_id(identity.clone(), &files).unwrap(),
        expected
    );
    assert_eq!(package_build_id(reordered, &files).unwrap(), expected);
    let mut reordered_array = identity;
    reordered_array["z"].as_array_mut().unwrap().reverse();
    assert_ne!(package_build_id(reordered_array, &files).unwrap(), expected);
}

#[test]
fn publishes_numbered_manifests_and_retains_current_and_rollback_packages() {
    let temporary = TempDir::new().unwrap();
    let store = PackageStore::open(temporary.path().join("store")).unwrap();
    let first = package(temporary.path(), "first", "one");
    let second = package(temporary.path(), "second", "two");
    let third = package(temporary.path(), "third", "three");

    let first = store.publish(first).unwrap();
    let second = store.publish(second).unwrap();
    let third = store.publish(third).unwrap();

    assert!(!first.package_root.exists());
    assert!(second.package_root.exists());
    assert!(third.package_root.exists());
    assert_eq!(
        store.current().unwrap().unwrap().package_root,
        third.package_root
    );
    assert_eq!(
        fs::read_dir(temporary.path().join("store/manifests"))
            .unwrap()
            .count(),
        2
    );
}

#[test]
fn leased_package_survives_cleanup_until_the_lease_is_released() {
    let temporary = TempDir::new().unwrap();
    let store = PackageStore::open(temporary.path().join("store")).unwrap();
    let first = store
        .publish(package(temporary.path(), "first", "one"))
        .unwrap();
    let _lease = PackageLease::acquire(&first.package_root).unwrap();
    store
        .publish(package(temporary.path(), "second", "two"))
        .unwrap();
    store
        .publish(package(temporary.path(), "third", "three"))
        .unwrap();

    assert!(first.package_root.exists());
    assert_eq!(
        fs::read_dir(temporary.path().join("store/manifests"))
            .unwrap()
            .count(),
        3
    );
}

#[test]
fn publishing_identical_contents_reuses_the_selected_package() {
    let temporary = TempDir::new().unwrap();
    let store = PackageStore::open(temporary.path().join("store")).unwrap();
    let first = store
        .publish(package(temporary.path(), "first", "same"))
        .unwrap();
    let repeated = store
        .publish(package(temporary.path(), "repeated", "same"))
        .unwrap();

    assert_eq!(first.package_root, repeated.package_root);
    assert_eq!(first.sequence, repeated.sequence);
}

#[test]
fn republishing_a_rollback_package_keeps_its_shared_directory() {
    let temporary = TempDir::new().unwrap();
    let store = PackageStore::open(temporary.path().join("store")).unwrap();
    let first = store
        .publish(package(temporary.path(), "first", "one"))
        .unwrap();
    store
        .publish(package(temporary.path(), "second", "two"))
        .unwrap();
    let restored = store
        .publish(package(temporary.path(), "restored", "one"))
        .unwrap();

    assert_eq!(restored.package_root, first.package_root);
    assert!(restored.package_root.exists());
    assert_eq!(
        fs::read_dir(temporary.path().join("store/manifests"))
            .unwrap()
            .count(),
        2
    );
}

#[test]
fn publication_removes_an_unreferenced_package_left_before_manifest_commit() {
    let temporary = TempDir::new().unwrap();
    let store_root = temporary.path().join("store");
    let store = PackageStore::open(&store_root).unwrap();
    let orphan = store_root
        .join("packages")
        .join("0.0.0")
        .join("f".repeat(64));
    fs::create_dir_all(&orphan).unwrap();
    fs::write(orphan.join(".lease"), []).unwrap();

    store
        .publish(package(temporary.path(), "current", "one"))
        .unwrap();

    assert!(!orphan.exists());
}

#[test]
fn packaged_executable_holds_a_shared_package_lease() {
    let temporary = TempDir::new().unwrap();
    let package = temporary.path().join("package");
    let bin = package.join("bin");
    fs::create_dir_all(&bin).unwrap();
    fs::write(package.join(".lease"), []).unwrap();
    let executable = bin.join("ash-app-server.exe");
    fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();

    let _lease = acquire_package_lease_for_executable(&executable)
        .unwrap()
        .unwrap();

    assert!(PackageLease::try_exclusive(&package).unwrap().is_none());
}

fn package(root: &Path, name: &str, contents: &str) -> std::path::PathBuf {
    let package = root.join(name);
    fs::create_dir(&package).unwrap();
    fs::write(package.join("artifact"), contents).unwrap();
    let file_digest = format!("{:x}", Sha256::digest(contents.as_bytes()));
    let files = BTreeMap::from([("artifact".to_string(), file_digest)]);
    let build_id = build_id(&files);
    fs::write(
        package.join("ash-package.json"),
        serde_json::to_vec(&json!({
            "buildId": build_id,
            "buildProfile": "dev-small",
            "files": files,
            "javascriptRuntime": { "kind": "hostProvidedNode" },
            "protocol": { "major": 1, "schemaHash": format!("sha256:{}", "a".repeat(64)) },
            "target": "x86_64-pc-windows-msvc",
            "version": "0.1.0"
        }))
        .unwrap(),
    )
    .unwrap();
    package
}

fn build_id(files: &BTreeMap<String, String>) -> String {
    let mut digest = Sha256::new();
    digest.update(b"ash-package-build-v2\0");
    let identity = json!({
        "buildProfile": "dev-small",
        "javascriptRuntime": { "kind": "hostProvidedNode" },
        "protocol": { "major": 1, "schemaHash": format!("sha256:{}", "a".repeat(64)) },
        "target": "x86_64-pc-windows-msvc",
        "version": "0.1.0"
    });
    digest.update(serde_json::to_vec(&identity).unwrap());
    digest.update(b"\0");
    for (path, file_digest) in files {
        digest.update(path.as_bytes());
        digest.update(b"\0");
        digest.update(file_digest.as_bytes());
        digest.update(b"\0");
    }
    format!("sha256:{:x}", digest.finalize())
}
