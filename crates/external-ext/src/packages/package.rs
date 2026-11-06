use ash_file_identity::FileInformation;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;

use super::packages::ExtensionPackagesError;
use super::resource::is_within;
use super::resource::validate_relative_path;

pub(crate) const MAX_MANIFEST_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_PACKAGE_FILE_BYTES: usize = 16 * 1024 * 1024;
pub(super) const MAX_PACKAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_PACKAGE_ENTRIES: usize = 8_192;
pub(super) const MAX_PACKAGE_FILES: usize = 4_096;

pub(crate) struct ExtensionPackageSnapshot {
    files: BTreeMap<String, Vec<u8>>,
    sha256: String,
    total_bytes: usize,
}

pub(crate) struct PackageSnapshotLimits {
    pub(crate) max_total_bytes: usize,
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct IndexedFile {
    pub(super) size: usize,
    pub(super) sha256: [u8; 32],
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct DeferredPackageIndex {
    pub(super) manifest: Vec<u8>,
    pub(super) files: BTreeMap<String, IndexedFile>,
    pub(super) sha256: String,
    pub(super) total_bytes: usize,
}

/// A product package bound to the verified distribution index and its canonical directory.
#[derive(Debug, Eq, PartialEq)]
pub struct DeferredExtensionPackage {
    root: PathBuf,
    pub(super) index: DeferredPackageIndex,
}

impl DeferredExtensionPackage {
    pub(super) fn new(root: PathBuf, index: DeferredPackageIndex) -> Self {
        Self { root, index }
    }

    /// Canonical installed directory bound to this index entry.
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub(super) fn read(&self, path: &str) -> Result<Vec<u8>, ExtensionPackagesError> {
        let indexed = self
            .index
            .files
            .get(path)
            .ok_or(ExtensionPackagesError::ResourceNotFound)?;
        let bytes = read_bounded_file(&self.root, &self.root.join(path), indexed.size as u64)
            .map_err(|_| ExtensionPackagesError::OperationFailed)?;
        if <[u8; 32]>::from(Sha256::digest(&bytes)) != indexed.sha256 {
            return Err(ExtensionPackagesError::OperationFailed);
        }
        Ok(bytes)
    }

    /// Verifies the exact package tree before handing its path to an executable runtime.
    pub fn verify(&self) -> Result<(), ExtensionPackagesError> {
        let verify = || {
            let metadata =
                fs::symlink_metadata(&self.root).map_err(|_| PackageSnapshotError::Unavailable)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(PackageSnapshotError::UnsafeEntry);
            }
            let mut budget = PackageScanBudget::new(self.index.total_bytes);
            let mut seen = std::collections::BTreeSet::new();
            scan_directory(
                &self.root,
                &self.root,
                Path::new(""),
                &mut budget,
                &mut |path, bytes| {
                    let Some(indexed) = self.index.files.get(&path) else {
                        return Err(PackageSnapshotError::Unavailable);
                    };
                    if !seen.insert(path)
                        || bytes.len() != indexed.size
                        || <[u8; 32]>::from(Sha256::digest(&bytes)) != indexed.sha256
                    {
                        return Err(PackageSnapshotError::Unavailable);
                    }
                    Ok(())
                },
            )?;
            if seen.len() != self.index.files.len() {
                return Err(PackageSnapshotError::Unavailable);
            }
            Ok(())
        };
        verify().map_err(|_| ExtensionPackagesError::OperationFailed)
    }
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
        let mut budget = PackageScanBudget::new(limits.max_total_bytes);
        if budget.max_bytes == 0 {
            return Err(PackageSnapshotError::PackageSetTooLarge);
        }
        scan_directory(
            root,
            root,
            Path::new(""),
            &mut budget,
            &mut |path, bytes| {
                if files.insert(path, bytes).is_some() {
                    return Err(PackageSnapshotError::UnsafeEntry);
                }
                Ok(())
            },
        )?;
        let sha256 = package_digest(&files);
        Ok(Self {
            files,
            sha256,
            total_bytes: budget.bytes,
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

    pub(super) fn from_indexed_files(files: BTreeMap<String, Vec<u8>>, total_bytes: usize) -> Self {
        let sha256 = package_digest(&files);
        Self {
            files,
            sha256,
            total_bytes,
        }
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
    PackageSetTooLarge,
}

struct PackageScanBudget {
    bytes: usize,
    entries: usize,
    files: usize,
    max_bytes: usize,
}

impl PackageScanBudget {
    fn new(max_bytes: usize) -> Self {
        Self {
            bytes: 0,
            entries: 0,
            files: 0,
            max_bytes: max_bytes.min(MAX_PACKAGE_BYTES),
        }
    }
}

fn scan_directory(
    root: &Path,
    directory: &Path,
    relative_directory: &Path,
    budget: &mut PackageScanBudget,
    visit: &mut impl FnMut(String, Vec<u8>) -> Result<(), PackageSnapshotError>,
) -> Result<(), PackageSnapshotError> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(directory).map_err(|_| PackageSnapshotError::Unavailable)? {
        budget.entries = budget
            .entries
            .checked_add(1)
            .ok_or(PackageSnapshotError::TooManyEntries)?;
        if budget.entries > MAX_PACKAGE_ENTRIES {
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
            scan_directory(root, &path, &relative, budget, visit)?;
            continue;
        }
        if !metadata.is_file() {
            return Err(PackageSnapshotError::UnsafeEntry);
        }
        if budget.files == MAX_PACKAGE_FILES {
            return Err(PackageSnapshotError::TooManyFiles);
        }
        let remaining_bytes = budget.max_bytes.saturating_sub(budget.bytes);
        if metadata.len() > remaining_bytes as u64 {
            return Err(if budget.max_bytes == MAX_PACKAGE_BYTES {
                PackageSnapshotError::PackageTooLarge
            } else {
                PackageSnapshotError::PackageSetTooLarge
            });
        }
        let bytes = read_bounded_file(root, &path, metadata.len())?;
        let next_total_bytes = budget
            .bytes
            .checked_add(bytes.len())
            .ok_or(PackageSnapshotError::PackageTooLarge)?;
        if next_total_bytes > budget.max_bytes {
            return Err(if budget.max_bytes == MAX_PACKAGE_BYTES {
                PackageSnapshotError::PackageTooLarge
            } else {
                PackageSnapshotError::PackageSetTooLarge
            });
        }
        budget.bytes = next_total_bytes;
        budget.files += 1;
        visit(relative_text, bytes)?;
    }
    Ok(())
}

fn read_bounded_file(
    root: &Path,
    path: &Path,
    expected_length: u64,
) -> Result<Vec<u8>, PackageSnapshotError> {
    read_bounded_regular_file(root, path, expected_length, MAX_PACKAGE_FILE_BYTES as u64)
}

pub(super) fn read_bounded_regular_file(
    root: &Path,
    path: &Path,
    expected_length: u64,
    max_bytes: u64,
) -> Result<Vec<u8>, PackageSnapshotError> {
    if expected_length > max_bytes {
        return Err(PackageSnapshotError::FileTooLarge);
    }
    let (inspected, canonical) = FileInformation::from_path_with_canonical(path)
        .map_err(|_| PackageSnapshotError::Unavailable)?;
    if inspected.has_multiple_links() {
        return Err(PackageSnapshotError::UnsafeEntry);
    }
    if !is_within(root, &canonical) {
        return Err(PackageSnapshotError::UnsafeEntry);
    }
    read_bounded_file_after_inspection(
        root,
        path,
        expected_length,
        max_bytes,
        inspected,
        &canonical,
    )
}

fn read_bounded_file_after_inspection(
    root: &Path,
    path: &Path,
    expected_length: u64,
    max_bytes: u64,
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
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| PackageSnapshotError::Unavailable)?;
    if bytes.len() as u64 > max_bytes {
        return Err(PackageSnapshotError::FileTooLarge);
    }
    let current = fs::symlink_metadata(path).map_err(|_| PackageSnapshotError::Unavailable)?;
    let (observed_information, current_canonical) = FileInformation::from_path_with_canonical(path)
        .map_err(|_| PackageSnapshotError::Unavailable)?;
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
