use std::fs;
use std::io::Write;

use tempfile::TempDir;

use super::UpdateOutput;
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
