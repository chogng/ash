use crate::manifest::PLUGIN_MANIFEST_PATH;
use crate::{PluginError, PluginErrorKind, PluginPackageDigest, PluginPath};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, Metadata};
use std::io::Read;
use std::path::{Path, PathBuf};

use super::local::PackageFileStats;
use super::local::PluginPackageDigestAlgorithm;

const MAX_PACKAGE_FILES: u64 = 10_000;
const MAX_PACKAGE_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PACKAGE_TOTAL_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ScannedEntryKind {
    Directory,
    File,
}

struct ScannedFile {
    relative: PluginPath,
    absolute: PathBuf,
    metadata: Metadata,
}

pub(super) struct ScannedPackage {
    pub(super) digest: PluginPackageDigest,
    pub(super) manifest_bytes: Vec<u8>,
    pub(super) entries: BTreeMap<PluginPath, ScannedEntryKind>,
    pub(super) stats: PackageFileStats,
}

pub(super) fn scan_and_digest(
    root: &Path,
    algorithm: PluginPackageDigestAlgorithm,
) -> Result<ScannedPackage, PluginError> {
    let mut entries = BTreeMap::new();
    let mut files = Vec::new();
    walk_directory(root, root, &mut entries, &mut files)?;
    files.sort_by(|left, right| left.relative.cmp(&right.relative));

    let mut hasher = Sha256::new();
    hasher.update(algorithm.domain());
    let mut manifest_bytes = None;
    let mut total_bytes = 0_u64;
    for file in &files {
        total_bytes = total_bytes
            .checked_add(file.metadata.len())
            .ok_or_else(|| unsafe_package("plugin package total size overflowed"))?;
        if total_bytes > MAX_PACKAGE_TOTAL_BYTES {
            return Err(unsafe_package(
                "plugin package exceeds the 256 MiB total size limit",
            ));
        }

        update_length(&mut hasher, file.relative.as_str().len() as u64);
        hasher.update(file.relative.as_str().as_bytes());
        update_length(&mut hasher, file.metadata.len());
        let bytes = hash_file(&mut hasher, file)?;
        if file.relative.as_str() == PLUGIN_MANIFEST_PATH {
            manifest_bytes = Some(bytes);
        }
    }
    let Some(manifest_bytes) = manifest_bytes else {
        return Err(PluginError::new(
            PluginErrorKind::SourceUnavailable,
            format!("plugin package is missing '{PLUGIN_MANIFEST_PATH}'"),
        ));
    };

    Ok(ScannedPackage {
        digest: PluginPackageDigest::from_hasher(hasher),
        manifest_bytes,
        entries,
        stats: PackageFileStats {
            file_count: files.len() as u64,
            total_bytes,
        },
    })
}

fn walk_directory(
    root: &Path,
    directory: &Path,
    entries: &mut BTreeMap<PluginPath, ScannedEntryKind>,
    files: &mut Vec<ScannedFile>,
) -> Result<(), PluginError> {
    let mut children: Vec<_> = fs::read_dir(directory)
        .map_err(|_| source_unavailable("plugin package directory cannot be read"))?
        .collect::<Result<_, _>>()
        .map_err(|_| source_unavailable("plugin package directory cannot be read"))?;
    children.sort_by_key(|entry| entry.file_name());

    for child in children {
        let absolute = child.path();
        let relative_path = absolute
            .strip_prefix(root)
            .map_err(|_| unsafe_package("plugin package entry escaped its root"))?;
        let relative = PluginPath::from_relative_path(relative_path)
            .map_err(|error| unsafe_package(format!("unsafe package path: {error}")))?;
        let metadata = fs::symlink_metadata(&absolute)
            .map_err(|_| source_unavailable("plugin package entry metadata cannot be read"))?;
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            return Err(unsafe_package(format!(
                "plugin package path '{relative}' is a symbolic link"
            )));
        }
        if file_type.is_dir() {
            entries.insert(relative, ScannedEntryKind::Directory);
            walk_directory(root, &absolute, entries, files)?;
            continue;
        }
        if !file_type.is_file() {
            return Err(unsafe_package(format!(
                "plugin package path '{relative}' is not a regular file or directory"
            )));
        }
        if metadata.len() > MAX_PACKAGE_FILE_BYTES {
            return Err(unsafe_package(format!(
                "plugin package path '{relative}' exceeds the 16 MiB per-file limit"
            )));
        }
        if files.len() as u64 >= MAX_PACKAGE_FILES {
            return Err(unsafe_package(
                "plugin package exceeds the 10000-file limit",
            ));
        }
        entries.insert(relative.clone(), ScannedEntryKind::File);
        files.push(ScannedFile {
            relative,
            absolute,
            metadata,
        });
    }
    Ok(())
}

fn hash_file(hasher: &mut Sha256, scanned: &ScannedFile) -> Result<Vec<u8>, PluginError> {
    let mut file = File::open(&scanned.absolute).map_err(|_| {
        source_unavailable(format!(
            "plugin package path '{}' cannot be read",
            scanned.relative
        ))
    })?;
    let opened_metadata = file.metadata().map_err(|_| {
        source_unavailable(format!(
            "plugin package path '{}' cannot be inspected",
            scanned.relative
        ))
    })?;
    if !opened_metadata.is_file() || opened_metadata.len() != scanned.metadata.len() {
        return Err(unsafe_package(format!(
            "plugin package path '{}' changed during validation",
            scanned.relative
        )));
    }
    let capture = scanned.relative.as_str() == PLUGIN_MANIFEST_PATH;
    let mut captured = Vec::new();
    let mut bytes_read = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|_| {
            source_unavailable(format!(
                "plugin package path '{}' cannot be read",
                scanned.relative
            ))
        })?;
        if count == 0 {
            break;
        }
        bytes_read += count as u64;
        if bytes_read > MAX_PACKAGE_FILE_BYTES {
            return Err(unsafe_package(format!(
                "plugin package path '{}' changed beyond the per-file limit during read",
                scanned.relative
            )));
        }
        hasher.update(&buffer[..count]);
        if capture {
            captured.extend_from_slice(&buffer[..count]);
        }
    }
    let observed_metadata = fs::symlink_metadata(&scanned.absolute).map_err(|_| {
        source_unavailable(format!(
            "plugin package path '{}' changed during validation",
            scanned.relative
        ))
    })?;
    if observed_metadata.file_type().is_symlink()
        || !observed_metadata.is_file()
        || observed_metadata.len() != scanned.metadata.len()
        || bytes_read != scanned.metadata.len()
    {
        return Err(unsafe_package(format!(
            "plugin package path '{}' changed during validation",
            scanned.relative
        )));
    }
    Ok(captured)
}

fn update_length(hasher: &mut Sha256, length: u64) {
    hasher.update(length.to_be_bytes());
}

fn source_unavailable(message: impl Into<String>) -> PluginError {
    PluginError::new(PluginErrorKind::SourceUnavailable, message)
}

fn unsafe_package(message: impl Into<String>) -> PluginError {
    PluginError::new(PluginErrorKind::PackageUnsafe, message)
}
