use std::fs;
use std::io::Write;

use tempfile::TempDir;

use super::UpdateOutput;
use super::eligible_for_automatic_updates;
use super::extract_zip;
use super::update_public_key;

#[test]
fn update_result_reports_when_the_selected_version_needs_a_restart() {
    let result = UpdateOutput {
        status: "installed",
        installed_version: "1.2.3".into(),
        restart_required: true,
    };
    assert_eq!(
        serde_json::to_value(result).unwrap(),
        serde_json::json!({
            "status": "installed",
            "installedVersion": "1.2.3",
            "restartRequired": true,
        })
    );
}

#[test]
fn update_key_comes_from_the_calling_product_package() {
    let root = TempDir::new().unwrap();
    let key = "a".repeat(64);
    fs::write(root.path().join("ash-package.json"), b"{\"components\":{}}").unwrap();
    fs::write(root.path().join("update-public-key"), format!("{key}\n")).unwrap();
    assert_eq!(
        update_public_key(root.path()).unwrap().as_bytes(),
        [0xaa; 32]
    );
    let cli_key = "b".repeat(64);
    fs::write(
        root.path().join("ash-package.json"),
        serde_json::to_vec(&serde_json::json!({
            "components": { "cli": { "updatePublicKey": cli_key } }
        }))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        update_public_key(root.path()).unwrap().as_bytes(),
        [0xbb; 32]
    );
    let backend_key = "c".repeat(64);
    fs::write(
        root.path().join("ash-package.json"),
        serde_json::to_vec(&serde_json::json!({
            "components": {
                "appServer": { "updatePublicKey": backend_key },
                "cli": { "updatePublicKey": cli_key },
            }
        }))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        update_public_key(root.path()).unwrap().as_bytes(),
        [0xcc; 32]
    );
}

#[test]
fn only_self_contained_release_packages_with_a_trusted_key_check_automatically() {
    let root = TempDir::new().unwrap();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let backend = crate::installation::backend_in(root.path());
    fs::write(&backend, b"backend").unwrap();
    let metadata_path = root.path().join("ash-package.json");
    let mut metadata = serde_json::json!({
        "layoutVersion": 2,
        "buildProfile": "release",
        "entrypoint": "bin/ash-app-server",
        "version": "1.2.3",
        "target": "aarch64-apple-darwin",
        "javascriptRuntime": {"kind": "packagedNode"},
        "protocol": {"major": 7, "capabilityVersion": 8},
        "components": {"appServer": {"updatePublicKey": "a".repeat(64)}},
    });
    fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap()).unwrap();
    assert!(eligible_for_automatic_updates(&backend).unwrap());

    metadata["components"]["appServer"]
        .as_object_mut()
        .unwrap()
        .remove("updatePublicKey");
    fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap()).unwrap();
    assert!(!eligible_for_automatic_updates(&backend).unwrap());

    metadata["components"]["appServer"]["updatePublicKey"] = serde_json::json!("a".repeat(64));
    metadata["buildProfile"] = serde_json::json!("dev-small");
    fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap()).unwrap();
    assert!(!eligible_for_automatic_updates(&backend).unwrap());
}

#[test]
fn signed_zip_extraction_rejects_paths_outside_the_package() {
    let root = TempDir::new().unwrap();
    let archive = root.path().join("update.zip");
    let file = fs::File::create(&archive).unwrap();
    let mut writer = zip::ZipWriter::new(file);
    writer
        .start_file("../outside", zip::write::SimpleFileOptions::default())
        .unwrap();
    writer.write_all(b"outside").unwrap();
    writer.finish().unwrap();
    let package = root.path().join("package");
    fs::create_dir(&package).unwrap();

    assert!(extract_zip(&archive, &package).is_err());
    assert!(!root.path().join("outside").exists());
}
