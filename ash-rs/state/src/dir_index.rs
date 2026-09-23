#![deny(unsafe_code)]

//! Profile-local database paths and cross-process lifecycle locks for rebuildable indexes.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use ash_file_access::DirId;
use ash_utils_path::CanonicalPathRoot;
use ash_utils_path::NoSymlinkPathError;
use ash_utils_path::NoSymlinkPathStatus;

const INDEXES_DIRECTORY: &str = "indexes";
const LOCKS_DIRECTORY: &str = "locks";
const DIRS_DIRECTORY: &str = "dirs";
const GLOBAL_LOCK_FILE: &str = "indexes.lock";
#[cfg(windows)]
const ERROR_LOCK_VIOLATION: i32 = 33;

/// One rebuildable index owned by a Directory.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum DirIndexKind {
    Grep,
    Codebase,
}

impl DirIndexKind {
    pub const ALL: [Self; 2] = [Self::Grep, Self::Codebase];

    pub const fn directory_name(self) -> &'static str {
        match self {
            Self::Grep => "grep",
            Self::Codebase => "codebase",
        }
    }

    fn lock_file_name(self) -> &'static str {
        match self {
            Self::Grep => "grep.lock",
            Self::Codebase => "codebase.lock",
        }
    }
}

/// Result of an explicit index deletion request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClearOutcome {
    Cleared,
    AlreadyAbsent,
    InUse,
}

/// Profile-level owner of durable database paths and rebuildable Directory index locks.
#[derive(Clone, Debug)]
pub struct StateRuntime {
    profile_root: PathBuf,
    database_path: PathBuf,
    connectors_database_path: PathBuf,
    cloud_codebase_root: PathBuf,
    writer_leases_root: PathBuf,
    cache_root: PathBuf,
    cache_boundary: CanonicalPathRoot,
    locks_root: PathBuf,
    dirs_root: PathBuf,
}

impl StateRuntime {
    pub fn open(profile_root: impl AsRef<Path>) -> io::Result<Self> {
        fs::create_dir_all(profile_root.as_ref())?;
        let profile_root = fs::canonicalize(profile_root.as_ref())?;
        let cache_root = profile_root.join("cache");
        let locks_root = cache_root.join(LOCKS_DIRECTORY);
        let dirs_root = cache_root.join(DIRS_DIRECTORY);
        let profile_boundary = CanonicalPathRoot::new(&profile_root)?;
        ensure_directory_without_symlinks(&profile_boundary, &cache_root)?;
        let cache_boundary = CanonicalPathRoot::new(&cache_root)?;
        ensure_directory_without_symlinks(&cache_boundary, &locks_root)?;
        ensure_directory_without_symlinks(&cache_boundary, &locks_root.join(DIRS_DIRECTORY))?;
        ensure_directory_without_symlinks(&cache_boundary, &dirs_root)?;
        Ok(Self {
            database_path: profile_root.join("state.sqlite3"),
            connectors_database_path: profile_root.join("connectors.sqlite3"),
            cloud_codebase_root: profile_root.join("state").join("cloud-codebase"),
            writer_leases_root: profile_root.join("leases"),
            profile_root,
            cache_root,
            cache_boundary,
            locks_root,
            dirs_root,
        })
    }

    /// Returns the profile root that contains durable state and rebuildable cache data.
    pub fn profile_root(&self) -> &Path {
        &self.profile_root
    }

    /// Returns the single durable profile database path.
    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    /// Returns the durable Connector authority database path for this profile.
    pub fn connectors_database_path(&self) -> &Path {
        &self.connectors_database_path
    }

    /// Returns the root containing durable Cloud Codebase state for this profile.
    pub fn cloud_codebase_root(&self) -> &Path {
        &self.cloud_codebase_root
    }

    /// Returns the directory containing Session and Thread writer lease files.
    pub fn writer_leases_root(&self) -> &Path {
        &self.writer_leases_root
    }

    pub fn cache_root(&self) -> &Path {
        &self.cache_root
    }

    pub fn acquire(&self, dir: &DirId, kind: DirIndexKind) -> io::Result<DirIndexLease> {
        let global_lock = self.open_global_lock()?;
        fs2::FileExt::lock_shared(&global_lock)?;

        let index_lock = self.open_index_lock(dir, kind)?;
        fs2::FileExt::lock_shared(&index_lock)?;

        let directory = self.index_directory(dir, kind);
        ensure_directory_without_symlinks(&self.cache_boundary, &directory)?;
        Ok(DirIndexLease {
            directory,
            _global_lock: global_lock,
            _index_lock: index_lock,
        })
    }

    pub fn clear_index(&self, dir: &DirId, kind: DirIndexKind) -> io::Result<ClearOutcome> {
        let global_lock = self.open_global_lock()?;
        fs2::FileExt::lock_shared(&global_lock)?;

        let index_lock = self.open_index_lock(dir, kind)?;
        if !try_lock_exclusive(&index_lock)? {
            return Ok(ClearOutcome::InUse);
        }
        remove_directory(&self.cache_boundary, &self.index_directory(dir, kind))
    }

    pub fn clear_dir(&self, dir: &DirId) -> io::Result<ClearOutcome> {
        let global_lock = self.open_global_lock()?;
        fs2::FileExt::lock_shared(&global_lock)?;

        let mut index_locks = Vec::with_capacity(DirIndexKind::ALL.len());
        for kind in DirIndexKind::ALL {
            let lock = self.open_index_lock(dir, kind)?;
            if !try_lock_exclusive(&lock)? {
                return Ok(ClearOutcome::InUse);
            }
            index_locks.push(lock);
        }
        remove_directory(&self.cache_boundary, &self.dir_directory(dir))
    }

    pub fn clear_all(&self) -> io::Result<ClearOutcome> {
        let global_lock = self.open_global_lock()?;
        if !try_lock_exclusive(&global_lock)? {
            return Ok(ClearOutcome::InUse);
        }
        let outcome = remove_directory(&self.cache_boundary, &self.dirs_root)?;
        ensure_directory_without_symlinks(&self.cache_boundary, &self.dirs_root)?;
        Ok(outcome)
    }

    pub fn index_directory(&self, dir: &DirId, kind: DirIndexKind) -> PathBuf {
        self.dir_directory(dir)
            .join(INDEXES_DIRECTORY)
            .join(kind.directory_name())
    }

    fn dir_directory(&self, dir: &DirId) -> PathBuf {
        self.dirs_root.join(dir_digest(dir))
    }

    fn open_global_lock(&self) -> io::Result<File> {
        open_lock_file(
            &self.cache_boundary,
            &self.locks_root.join(GLOBAL_LOCK_FILE),
        )
    }

    fn open_index_lock(&self, dir: &DirId, kind: DirIndexKind) -> io::Result<File> {
        open_lock_file(
            &self.cache_boundary,
            &self
                .locks_root
                .join(DIRS_DIRECTORY)
                .join(dir_digest(dir))
                .join(kind.lock_file_name()),
        )
    }
}

/// Shared lifecycle lock held while an index is open or being rebuilt.
#[derive(Debug)]
pub struct DirIndexLease {
    directory: PathBuf,
    _global_lock: File,
    _index_lock: File,
}

impl DirIndexLease {
    pub fn directory(&self) -> &Path {
        &self.directory
    }
}

fn dir_digest(dir: &DirId) -> &str {
    dir.as_str()
        .strip_prefix("sha256:")
        .expect("DirId always contains the sha256 prefix")
}

fn open_lock_file(boundary: &CanonicalPathRoot, path: &Path) -> io::Result<File> {
    if let Some(parent) = path.parent() {
        ensure_directory_without_symlinks(boundary, parent)?;
    }
    boundary
        .inspect_without_symlinks(path)
        .map_err(no_symlink_path_error)?;
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
}

fn try_lock_exclusive(file: &File) -> io::Result<bool> {
    match fs2::FileExt::try_lock_exclusive(file) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(false),
        #[cfg(windows)]
        Err(error) if error.raw_os_error() == Some(ERROR_LOCK_VIOLATION) => Ok(false),
        Err(error) => Err(error),
    }
}

fn remove_directory(boundary: &CanonicalPathRoot, path: &Path) -> io::Result<ClearOutcome> {
    match boundary
        .inspect_without_symlinks(path)
        .map_err(no_symlink_path_error)?
    {
        NoSymlinkPathStatus::Existing => match fs::remove_dir_all(path) {
            Ok(()) => Ok(ClearOutcome::Cleared),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                Ok(ClearOutcome::AlreadyAbsent)
            }
            Err(error) => Err(error),
        },
        NoSymlinkPathStatus::Missing => Ok(ClearOutcome::AlreadyAbsent),
    }
}

fn ensure_directory_without_symlinks(boundary: &CanonicalPathRoot, path: &Path) -> io::Result<()> {
    let status = boundary
        .inspect_without_symlinks(path)
        .map_err(no_symlink_path_error)?;
    if status == NoSymlinkPathStatus::Missing {
        fs::create_dir_all(path)?;
    }
    let status = boundary
        .inspect_without_symlinks(path)
        .map_err(no_symlink_path_error)?;
    if status != NoSymlinkPathStatus::Existing || !fs::symlink_metadata(path)?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("state path is not a directory: {}", path.display()),
        ));
    }
    Ok(())
}

fn no_symlink_path_error(error: NoSymlinkPathError) -> io::Error {
    let kind = match &error {
        NoSymlinkPathError::Unavailable { source, .. } => source.kind(),
        NoSymlinkPathError::OutsideRoot(_) | NoSymlinkPathError::Symlink(_) => {
            io::ErrorKind::InvalidData
        }
    };
    io::Error::new(kind, error)
}

#[cfg(test)]
#[path = "dir_index_tests.rs"]
mod tests;
