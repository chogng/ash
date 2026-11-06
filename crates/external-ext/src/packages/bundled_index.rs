use flate2::bufread::GzDecoder;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::Path;

use super::budget::MAX_PACKAGES_PACKAGE_CANDIDATES;
use super::budget::MAX_PACKAGES_SNAPSHOT_BYTES;
use super::package::ExtensionPackageSnapshot;
use super::package::MAX_PACKAGE_BYTES;
use super::package::MAX_PACKAGE_FILE_BYTES;
use super::package::MAX_PACKAGE_FILES;
use super::package::read_bounded_regular_file;
use super::resource::validate_relative_path;

const INDEX_NAME: &str = "extensions.index";
const MANIFEST_KEY: &str = "ash-resources/extensions.index";
const MAGIC: &[u8] = b"ASH-EXTENSIONS\0\x01";
const MAX_INDEX_BYTES: u64 = MAX_PACKAGES_SNAPSHOT_BYTES as u64 + 16 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 1024 * 1024;

/// Reads a versioned index of frozen built-in files from this distribution.
pub(super) fn load(
    extensions: &Path,
    metadata_path: &Path,
) -> Option<BTreeMap<String, ExtensionPackageSnapshot>> {
    let resources = extensions.parent()?;
    let package = resources.parent()?;
    let index_path = resources.join(INDEX_NAME);
    if !index_path.is_file() {
        return None;
    }
    let metadata = read_regular(package, metadata_path, MAX_METADATA_BYTES)?;
    let metadata: Value = serde_json::from_slice(&metadata).ok()?;
    let expected = metadata.get("files")?.get(MANIFEST_KEY)?.as_str()?;
    let bytes = read_regular(resources, &index_path, MAX_INDEX_BYTES)?;
    if format!("{:x}", Sha256::digest(&bytes)) != expected {
        return None;
    }
    let mut decoder = GzDecoder::new(bytes.as_slice()).take(MAX_INDEX_BYTES + 1);
    let packages = decode(&mut decoder)?;
    if decoder.limit() == 0 || !decoder.into_inner().into_inner().is_empty() {
        return None;
    }
    Some(packages)
}

fn read_regular(root: &Path, path: &Path, max_bytes: u64) -> Option<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    read_bounded_regular_file(root, path, metadata.len(), max_bytes).ok()
}

fn decode(input: &mut impl Read) -> Option<BTreeMap<String, ExtensionPackageSnapshot>> {
    let mut magic = [0; MAGIC.len()];
    input.read_exact(&mut magic).ok()?;
    if magic != MAGIC {
        return None;
    }
    let package_count = number(input)?;
    if package_count == 0 || package_count > MAX_PACKAGES_PACKAGE_CANDIDATES {
        return None;
    }
    let mut packages = BTreeMap::new();
    let mut total = 0usize;
    for _ in 0..package_count {
        let directory = name(input)?;
        if !directory
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        {
            return None;
        }
        let file_count = number(input)?;
        if file_count == 0 || file_count > MAX_PACKAGE_FILES {
            return None;
        }
        let mut files = BTreeMap::new();
        let mut package_bytes = 0usize;
        for _ in 0..file_count {
            let path = name(input)?;
            validate_relative_path(&path).ok()?;
            let size = number(input)?;
            package_bytes = package_bytes.checked_add(size)?;
            total = total.checked_add(size)?;
            if size > MAX_PACKAGE_FILE_BYTES
                || package_bytes > MAX_PACKAGE_BYTES
                || total > MAX_PACKAGES_SNAPSHOT_BYTES
            {
                return None;
            }
            let mut bytes = vec![0; size];
            input.read_exact(&mut bytes).ok()?;
            if files.insert(path, bytes).is_some() {
                return None;
            }
        }
        let manifest = files.get("package.json")?;
        // Executable consumers can use the physical installation tree. Keep that
        // tree's validation on the directory path even if an index lists the package.
        if !serde_json::from_slice::<Value>(manifest)
            .ok()
            .is_some_and(|manifest| {
                manifest.is_object()
                    && ["main", "browser", "ashRuntime", "ashLanguageServers"]
                        .into_iter()
                        .all(|key| manifest.get(key).is_none())
                    && manifest.pointer("/contributes/debuggers").is_none()
            })
        {
            continue;
        }
        if packages
            .insert(
                directory,
                ExtensionPackageSnapshot::from_indexed_files(files, package_bytes),
            )
            .is_some()
        {
            return None;
        }
    }
    (input.read(&mut [0]).ok()? == 0).then_some(packages)
}

fn number(input: &mut impl Read) -> Option<usize> {
    let mut bytes = [0; 4];
    input.read_exact(&mut bytes).ok()?;
    Some(u32::from_be_bytes(bytes) as usize)
}

fn name(input: &mut impl Read) -> Option<String> {
    let len = number(input)?;
    if len == 0 || len > 1024 {
        return None;
    }
    let mut bytes = vec![0; len];
    input.read_exact(&mut bytes).ok()?;
    String::from_utf8(bytes).ok()
}

#[cfg(test)]
#[path = "bundled_index_tests.rs"]
mod tests;
