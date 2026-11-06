use super::MAGIC;
use super::MANIFEST_KEY;
use super::decode;
use crate::packages::ExtensionPackages;
use crate::packages::ExtensionPackagesReload;
use crate::packages::ExtensionRoot;
use flate2::Compression;
use flate2::write::GzEncoder;
use sha2::Digest;
use sha2::Sha256;
use std::fs;
use std::io::Write;

const MANIFEST: &[u8] = br#"{"name":"demo","publisher":"ash","version":"1.0.0"}"#;

fn write_number(output: &mut Vec<u8>, size: usize) {
    output.extend_from_slice(&(size as u32).to_be_bytes());
}

fn write_field(output: &mut Vec<u8>, field: &[u8]) {
    write_number(output, field.len());
    output.extend_from_slice(field);
}

fn index_with_resource(path: &str, resource: &[u8]) -> Vec<u8> {
    index_with_manifest(MANIFEST, path, resource)
}

fn index_with_manifest(manifest: &[u8], path: &str, resource: &[u8]) -> Vec<u8> {
    let mut bytes = MAGIC.to_vec();
    write_number(&mut bytes, 1);
    write_field(&mut bytes, b"demo");
    write_number(&mut bytes, 2);
    write_field(&mut bytes, b"package.json");
    write_field(&mut bytes, manifest);
    write_field(&mut bytes, path.as_bytes());
    write_field(&mut bytes, resource);
    bytes
}

#[test]
fn verified_index_matches_directory_and_a_corrupt_index_falls_back() {
    let install = tempfile::tempdir().unwrap();
    let resources = install.path().join("ash-resources");
    let extensions = resources.join("extensions");
    let package = extensions.join("demo");
    fs::create_dir_all(&package).unwrap();
    fs::write(package.join("package.json"), MANIFEST).unwrap();
    fs::write(package.join("resource.json"), b"original").unwrap();
    let metadata = install.path().join("ash-package.json");
    let index = resources.join("extensions.index");
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder
        .write_all(&index_with_resource("resource.json", b"original"))
        .unwrap();
    let bytes = encoder.finish().unwrap();
    let sha = format!("{:x}", Sha256::digest(&bytes));
    fs::write(
        &metadata,
        serde_json::json!({ "files": { MANIFEST_KEY: sha } }).to_string(),
    )
    .unwrap();
    fs::write(&index, &bytes).unwrap();

    let root = ExtensionRoot::built_in(extensions);
    let mut scanned = ExtensionPackages::new(vec![root.clone()]);
    let mut indexed =
        ExtensionPackages::new(vec![root.clone().with_package_metadata(metadata.clone())]);
    let expected = scanned.list(ExtensionPackagesReload::Cached);
    assert_eq!(expected.extensions.len(), 1);
    assert_eq!(indexed.list(ExtensionPackagesReload::Cached), expected);

    fs::write(package.join("resource.json"), b"replacement").unwrap();
    assert_eq!(
        indexed
            .open_resource(expected.generation, "ash.demo", "resource.json")
            .unwrap()
            .bytes,
        b"original"
    );
    fs::write(&index, index_with_resource("resource.json", b"unverified")).unwrap();
    let mut fallback = ExtensionPackages::new(vec![root.with_package_metadata(metadata)]);
    let snapshot = fallback.list(ExtensionPackagesReload::Cached);
    assert_ne!(snapshot.extensions, expected.extensions);
    assert_eq!(
        fallback
            .open_resource(snapshot.generation, "ash.demo", "resource.json")
            .unwrap()
            .bytes,
        b"replacement"
    );
}

#[test]
fn rejects_traversal_duplicates_and_truncated_entries() {
    assert!(decode(&mut index_with_resource("../escape", b"content").as_slice()).is_none());
    assert!(decode(&mut index_with_resource("package.json", b"duplicate").as_slice()).is_none());
    let mut truncated = index_with_resource("resource.json", b"content");
    truncated.pop();
    assert!(decode(&mut truncated.as_slice()).is_none());
}

#[test]
fn executable_packages_are_left_to_the_directory_scanner() {
    for manifest in [
        br#"{"main":"extension.js"}"#.as_slice(),
        br#"{"ashLanguageServers":{"version":2}}"#.as_slice(),
        br#"{"contributes":{"debuggers":[{"program":"adapter.js"}]}}"#.as_slice(),
    ] {
        let index = index_with_manifest(manifest, "resource.json", b"content");
        assert!(decode(&mut index.as_slice()).unwrap().is_empty());
    }
}
