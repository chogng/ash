use ash_file_identity::FileInformation;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::Path;

use crate::resource::is_within;
use crate::resource::validate_relative_path;

pub(crate) const MAX_MANIFEST_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_PACKAGE_FILE_BYTES: usize = 16 * 1024 * 1024;
const MAX_PACKAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_PACKAGE_ENTRIES: usize = 8_192;
const MAX_PACKAGE_FILES: usize = 4_096;

pub(crate) struct ExtensionPackageSnapshot {
    files: BTreeMap<String, Vec<u8>>,
    sha256: String,
    total_bytes: usize,
}

pub(crate) struct PackageSnapshotLimits {
    pub(crate) max_total_bytes: usize,
}

impl ExtensionPackageSnapshot {
    pub(crate) fn load(
        root: &Path,
        limits: PackageSnapshotLimits,
    ) -> Result<Self, PackageSnapshotError> {
        let metadata = fs::symlink_metadata(root).map_err(|_| PackageSnapshotError::Unavailable)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(PackageSnapshotError::UnsafeEntry);
        }
        let mut files = BTreeMap::new();
        let mut total_bytes = 0usize;
        let mut total_entries = 0usize;
        let max_total_bytes = limits.max_total_bytes.min(MAX_PACKAGE_BYTES);
        if max_total_bytes == 0 {
            return Err(PackageSnapshotError::CatalogTooLarge);
        }
        scan_directory(
            root,
            root,
            Path::new(""),
            &mut files,
            &mut total_bytes,
            &mut total_entries,
            max_total_bytes,
        )?;
        let sha256 = package_digest(&files);
        Ok(Self {
            files,
            sha256,
            total_bytes,
        })
    }

    pub(crate) fn file(&self, path: &str) -> Option<&[u8]> {
        self.files.get(path).map(Vec::as_slice)
    }

    pub(crate) fn sha256(&self) -> &str {
        &self.sha256
    }

    pub(crate) fn total_bytes(&self) -> usize {
        self.total_bytes
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PackageSnapshotError {
    Unavailable,
    UnsafeEntry,
    TooManyEntries,
    TooManyFiles,
    FileTooLarge,
    PackageTooLarge,
    CatalogTooLarge,
}

fn scan_directory(
    root: &Path,
    directory: &Path,
    relative_directory: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
    total_bytes: &mut usize,
    total_entries: &mut usize,
    max_total_bytes: usize,
) -> Result<(), PackageSnapshotError> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(directory).map_err(|_| PackageSnapshotError::Unavailable)? {
        *total_entries = total_entries
            .checked_add(1)
            .ok_or(PackageSnapshotError::TooManyEntries)?;
        if *total_entries > MAX_PACKAGE_ENTRIES {
            return Err(PackageSnapshotError::TooManyEntries);
        }
        entries.push(entry.map_err(|_| PackageSnapshotError::Unavailable)?);
    }
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| PackageSnapshotError::UnsafeEntry)?;
        let relative = relative_directory.join(&name);
        let relative_text = relative_path_text(&relative)?;
        let path = entry.path();
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| PackageSnapshotError::Unavailable)?;
        if metadata.file_type().is_symlink() {
            return Err(PackageSnapshotError::UnsafeEntry);
        }
        if metadata.is_dir() {
            scan_directory(
                root,
                &path,
                &relative,
                files,
                total_bytes,
                total_entries,
                max_total_bytes,
            )?;
            continue;
        }
        if !metadata.is_file() {
            return Err(PackageSnapshotError::UnsafeEntry);
        }
        if files.len() == MAX_PACKAGE_FILES {
            return Err(PackageSnapshotError::TooManyFiles);
        }
        let remaining_bytes = max_total_bytes.saturating_sub(*total_bytes);
        if metadata.len() > remaining_bytes as u64 {
            return Err(if max_total_bytes == MAX_PACKAGE_BYTES {
                PackageSnapshotError::PackageTooLarge
            } else {
                PackageSnapshotError::CatalogTooLarge
            });
        }
        let bytes = read_bounded_file(root, &path, metadata.len())?;
        let next_total_bytes = total_bytes
            .checked_add(bytes.len())
            .ok_or(PackageSnapshotError::PackageTooLarge)?;
        if next_total_bytes > max_total_bytes {
            return Err(if max_total_bytes == MAX_PACKAGE_BYTES {
                PackageSnapshotError::PackageTooLarge
            } else {
                PackageSnapshotError::CatalogTooLarge
            });
        }
        *total_bytes = next_total_bytes;
        if files.insert(relative_text, bytes).is_some() {
            return Err(PackageSnapshotError::UnsafeEntry);
        }
    }
    Ok(())
}

fn read_bounded_file(
    root: &Path,
    path: &Path,
    expected_length: u64,
) -> Result<Vec<u8>, PackageSnapshotError> {
    if expected_length > MAX_PACKAGE_FILE_BYTES as u64 {
        return Err(PackageSnapshotError::FileTooLarge);
    }
    let inspected =
        FileInformation::from_path(path).map_err(|_| PackageSnapshotError::Unavailable)?;
    if inspected.has_multiple_links() {
        return Err(PackageSnapshotError::UnsafeEntry);
    }
    let canonical = fs::canonicalize(path).map_err(|_| PackageSnapshotError::Unavailable)?;
    if !is_within(root, &canonical) {
        return Err(PackageSnapshotError::UnsafeEntry);
    }
    read_bounded_file_after_inspection(root, path, expected_length, inspected, &canonical)
}

fn read_bounded_file_after_inspection(
    root: &Path,
    path: &Path,
    expected_length: u64,
    inspected: FileInformation,
    canonical: &Path,
) -> Result<Vec<u8>, PackageSnapshotError> {
    if !is_within(root, canonical) {
        return Err(PackageSnapshotError::UnsafeEntry);
    }
    let mut file = fs::File::open(canonical).map_err(|_| PackageSnapshotError::Unavailable)?;
    let opened_information =
        FileInformation::from_file(&file).map_err(|_| PackageSnapshotError::Unavailable)?;
    let opened = file
        .metadata()
        .map_err(|_| PackageSnapshotError::Unavailable)?;
    if !opened.is_file()
        || opened.len() != expected_length
        || !opened_information.same_file_as(inspected)
        || opened_information.has_multiple_links()
    {
        return Err(PackageSnapshotError::Unavailable);
    }
    let mut bytes = Vec::with_capacity(expected_length as usize);
    file.by_ref()
        .take(MAX_PACKAGE_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| PackageSnapshotError::Unavailable)?;
    if bytes.len() > MAX_PACKAGE_FILE_BYTES {
        return Err(PackageSnapshotError::FileTooLarge);
    }
    let current = fs::symlink_metadata(path).map_err(|_| PackageSnapshotError::Unavailable)?;
    let current_canonical =
        fs::canonicalize(path).map_err(|_| PackageSnapshotError::Unavailable)?;
    let observed_information =
        FileInformation::from_path(path).map_err(|_| PackageSnapshotError::Unavailable)?;
    if current.file_type().is_symlink()
        || !current.is_file()
        || bytes.len() as u64 != expected_length
        || current.len() != bytes.len() as u64
        || !is_within(root, &current_canonical)
        || current_canonical != canonical
        || !observed_information.same_file_as(opened_information)
        || observed_information.has_multiple_links()
    {
        return Err(PackageSnapshotError::Unavailable);
    }
    Ok(bytes)
}

fn relative_path_text(path: &Path) -> Result<String, PackageSnapshotError> {
    let value = path
        .iter()
        .map(|segment| segment.to_str().ok_or(PackageSnapshotError::UnsafeEntry))
        .collect::<Result<Vec<_>, _>>()?
        .join("/");
    validate_relative_path(&value).map_err(|_| PackageSnapshotError::UnsafeEntry)?;
    Ok(value)
}

fn package_digest(files: &BTreeMap<String, Vec<u8>>) -> String {
    let mut digest = Sha256::new();
    digest.update(b"ash-extension-package-v1\0");
    for (path, bytes) in files {
        digest.update((path.len() as u64).to_be_bytes());
        digest.update(path.as_bytes());
        digest.update((bytes.len() as u64).to_be_bytes());
        digest.update(bytes);
    }
    let digest = digest.finalize();
    format!("sha256:{digest:x}")
}

#[cfg(test)]
#[path = "package_tests.rs"]
mod tests;
