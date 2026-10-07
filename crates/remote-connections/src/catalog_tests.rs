use std::fs;

use ash_remote::RemoteArchitecture;
use ash_remote::RemoteLinuxLibc;
use ash_remote::RemotePlatform;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use tempfile::TempDir;

use crate::RemoteRuntimeCatalog;

#[test]
fn verified_catalog_selects_one_exact_artifact_per_remote_target() {
    let directory = TempDir::new().unwrap();
    fs::create_dir(directory.path().join("artifacts")).unwrap();
    let bytes = serde_json::to_vec(&json!({
        "formatVersion": 1,
        "artifacts": [{
            "version": "0.1.0",
            "target": "x86_64-unknown-linux-gnu",
            "archive": "artifacts/ash-x86_64-unknown-linux-gnu.tar.gz",
            "archiveSize": 41,
            "unpackedSize": 97,
            "sha256": "a".repeat(64),
        }],
    }))
    .unwrap();
    let catalog_path = directory.path().join("catalog.json");
    fs::write(&catalog_path, &bytes).unwrap();
    let digest = format!("{:x}", Sha256::digest(&bytes));

    let catalog = RemoteRuntimeCatalog::load_verified(&catalog_path, digest).unwrap();
    let platform = RemotePlatform::linux(RemoteArchitecture::X86_64, RemoteLinuxLibc::Gnu);
    let artifact = catalog.artifact_for(platform).unwrap();

    assert_eq!(artifact.version().as_str(), "0.1.0");
    assert_eq!(artifact.platform(), platform);
    assert_eq!(
        artifact.archive(),
        directory
            .path()
            .join("artifacts/ash-x86_64-unknown-linux-gnu.tar.gz")
    );
    assert_eq!(artifact.integrity().archive_size().get(), 41);
    assert_eq!(artifact.integrity().unpacked_size().get(), 97);
}

#[test]
fn catalog_digest_is_checked_before_parsing_untrusted_json() {
    let directory = TempDir::new().unwrap();
    let catalog_path = directory.path().join("catalog.json");
    fs::write(&catalog_path, b"not-json").unwrap();

    let error = RemoteRuntimeCatalog::load_verified(&catalog_path, "0".repeat(64)).unwrap_err();
    assert!(error.to_string().contains("SHA-256 mismatch"));
}

#[test]
fn catalog_rejects_duplicate_targets_and_escaping_archive_paths() {
    let duplicate = json!({
        "formatVersion": 1,
        "artifacts": [record("artifacts/one.tar.gz"), record("artifacts/two.tar.gz")],
    });
    let error = load_document(duplicate).unwrap_err();
    assert!(error.to_string().contains("repeats target"));

    let escaping = json!({
        "formatVersion": 1,
        "artifacts": [record("../outside.tar.gz")],
    });
    let error = load_document(escaping).unwrap_err();
    assert!(error.to_string().contains("canonical relative path"));
}

fn record(archive: &str) -> serde_json::Value {
    json!({
        "version": "0.1.0",
        "target": "x86_64-unknown-linux-gnu",
        "archive": archive,
        "archiveSize": 41,
        "unpackedSize": 97,
        "sha256": "a".repeat(64),
    })
}

fn load_document(
    document: serde_json::Value,
) -> Result<RemoteRuntimeCatalog, crate::RemoteRuntimeCatalogError> {
    let directory = TempDir::new().unwrap();
    let bytes = serde_json::to_vec(&document).unwrap();
    let path = directory.path().join("catalog.json");
    fs::write(&path, &bytes).unwrap();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    RemoteRuntimeCatalog::load_verified(path, digest)
}
