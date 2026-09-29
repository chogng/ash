use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use tempfile::TempDir;

use super::install_from_client;
use super::selected_backend;

#[test]
fn clients_with_different_versions_keep_the_profile_backend_selection() {
    let directory = TempDir::new().unwrap();
    let first = package(directory.path(), "client-one", "0.1.0");
    let second = package(directory.path(), "client-two", "0.2.0");
    let profile = directory.path().join("profile");
    fs::create_dir(&profile).unwrap();

    let selected = selected_backend(&profile, &first).unwrap();
    let later = selected_backend(&profile, &second).unwrap();

    assert_eq!(later, selected);
    assert!(selected.starts_with(profile.join("app-server-packages")));
    assert_eq!(fs::read(selected).unwrap(), b"0.1.0");

    let updated = install_from_client(&profile, &second).unwrap();
    fs::remove_dir_all(second.parent().unwrap().parent().unwrap()).unwrap();
    let old_client = selected_backend(&profile, &first).unwrap();
    assert_eq!(old_client, updated);
    assert_eq!(fs::read(updated).unwrap(), b"0.2.0");
    let version = crate::run_lifecycle(
        crate::LifecycleCommand::Version,
        crate::ConnectionOptions::new(&profile, None, crate::GrantSource::HostConfiguration, None),
        &first,
    )
    .unwrap();
    assert_eq!(version.installed_version.as_deref(), Some("0.2.0"));
}

#[test]
fn release_backend_must_have_its_own_javascript_runtime() {
    let directory = TempDir::new().unwrap();
    let executable = package(directory.path(), "client", "0.1.0");
    let manifest_path = executable
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("ash-package.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["javascriptRuntime"]["kind"] = json!("hostProvidedNode");
    fs::write(manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();

    let error = install_from_client(directory.path(), &executable).unwrap_err();
    assert_eq!(
        error,
        "App Server installation requires a self-contained package"
    );
}

#[test]
fn packaged_backend_must_be_the_manifest_entrypoint() {
    let directory = TempDir::new().unwrap();
    let executable = package(directory.path(), "client", "0.1.0");
    let other = executable.parent().unwrap().join("other-server");
    fs::copy(&executable, &other).unwrap();

    let error = install_from_client(directory.path(), &other).unwrap_err();
    assert_eq!(
        error,
        "App Server executable does not match its package entrypoint"
    );
}

fn package(root: &Path, name: &str, version: &str) -> std::path::PathBuf {
    let package = root.join(name);
    let bin = package.join("bin");
    fs::create_dir(&package).unwrap();
    fs::create_dir(&bin).unwrap();
    let binary = bin.join(if cfg!(windows) {
        "ash-app-server.exe"
    } else {
        "ash-app-server"
    });
    fs::write(&binary, version).unwrap();
    let relative = format!("bin/{}", binary.file_name().unwrap().to_string_lossy());
    let file_digest = format!("{:x}", Sha256::digest(version.as_bytes()));
    let files = BTreeMap::from([(relative, file_digest)]);
    let identity = json!({
        "buildProfile": "release",
        "javascriptRuntime": { "kind": "packagedNode" },
        "protocol": { "major": 1, "revision": 2, "schemaHash": format!("sha256:{}", "a".repeat(64)) },
        "target": "aarch64-apple-darwin",
        "version": version,
    });
    let mut digest = Sha256::new();
    digest.update(b"ash-package-build-v2\0");
    digest.update(serde_json::to_vec(&identity).unwrap());
    digest.update(b"\0");
    for (path, file_digest) in &files {
        digest.update(path.as_bytes());
        digest.update(b"\0");
        digest.update(file_digest.as_bytes());
        digest.update(b"\0");
    }
    fs::write(
        package.join("ash-package.json"),
        serde_json::to_vec(&json!({
            "buildId": format!("sha256:{:x}", digest.finalize()),
            "buildProfile": "release",
            "files": files,
            "javascriptRuntime": { "kind": "packagedNode" },
            "protocol": { "major": 1, "revision": 2, "schemaHash": format!("sha256:{}", "a".repeat(64)) },
            "target": "aarch64-apple-darwin",
            "version": version,
        }))
        .unwrap(),
    )
    .unwrap();
    binary
}
