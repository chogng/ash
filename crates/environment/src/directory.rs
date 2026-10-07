use crate::EnvId;
use ash_utils_absolute_path::AbsolutePathBuf;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use thiserror::Error;

/// Failure to establish or resolve one directory filesystem boundary.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum DirPathError {
    #[error("directory root does not exist or cannot be resolved: {path}: {message}")]
    RootUnavailable { path: PathBuf, message: String },
    #[error("directory root is not a directory: {}", .0.display())]
    RootNotDirectory(PathBuf),
    #[error("path must be relative and contain no parent, root, or platform prefix: {}", .0.display())]
    InvalidRelativePath(PathBuf),
    #[error("path is outside the directory root: {}", .0.display())]
    OutsideDir(PathBuf),
}

/// File driver for the execution environment hosted by this process.
/// The host binds its environment identity once; callers cannot select an environment per path.
#[derive(Clone, Debug)]
pub struct LocalFileDriver {
    env: EnvId,
}

impl LocalFileDriver {
    pub fn new(env: EnvId) -> Self {
        Self { env }
    }
    pub fn open_directory(&self, path: impl AsRef<Path>) -> Result<Directory, DirPathError> {
        Directory::open(self.env.clone(), path)
    }
}

/// Stable identity and filesystem boundary for one existing directory.
///
/// Identity includes the opened directory object and canonical path. The originally requested path is retained because
/// operating-system watcher events can use a lexical alias such as macOS `/var` while filesystem
/// and Git APIs report `/private/var`. That alias is lexically normalized so observed paths can be
/// matched by prefix, while canonicalization runs on the caller's original spelling so `..` after
/// a symlinked component keeps operating-system semantics.
#[derive(Clone, Debug)]
pub struct Directory {
    handle: Arc<cap_std::fs::Dir>,
    object: [u64; 2],
    writes: Arc<std::sync::Mutex<()>>,
    active: Arc<std::sync::atomic::AtomicBool>,
    env: EnvId,
    requested: AbsolutePathBuf,
    canonical: PathBuf,
}

impl Directory {
    /// Opens one existing directory and freezes both its requested and canonical namespaces.
    fn open(env: EnvId, path: impl AsRef<Path>) -> Result<Self, DirPathError> {
        let path = path.as_ref();
        let requested = AbsolutePathBuf::resolve_against_current_dir(path).map_err(|error| {
            DirPathError::RootUnavailable {
                path: path.to_path_buf(),
                message: error.to_string(),
            }
        })?;
        let canonical =
            dunce::canonicalize(path).map_err(|error| DirPathError::RootUnavailable {
                path: requested.to_path_buf(),
                message: error.to_string(),
            })?;
        let metadata = canonical
            .metadata()
            .map_err(|error| DirPathError::RootUnavailable {
                path: canonical.clone(),
                message: error.to_string(),
            })?;
        if !metadata.is_dir() {
            return Err(DirPathError::RootNotDirectory(canonical));
        }
        let handle = cap_std::fs::Dir::open_ambient_dir(&canonical, cap_std::ambient_authority())
            .map_err(|error| DirPathError::RootUnavailable {
            path: canonical.clone(),
            message: error.to_string(),
        })?;
        let object = object_identity(&handle).map_err(|error| DirPathError::RootUnavailable {
            path: canonical.clone(),
            message: error.to_string(),
        })?;
        Ok(Self {
            handle: Arc::new(handle),
            object,
            writes: directory_write_lock(object),
            active: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            env,
            requested,
            canonical,
        })
    }

    /// Opens one directory in the host-local execution environment.
    pub fn open_local(path: impl AsRef<Path>) -> Result<Self, DirPathError> {
        LocalFileDriver::new(EnvId::local()).open_directory(path)
    }

    pub fn driver(&self) -> LocalFileDriver {
        LocalFileDriver::new(self.env.clone())
    }

    /// Returns the execution environment containing this directory.
    pub fn env(&self) -> &EnvId {
        &self.env
    }

    /// Returns the absolute path supplied by the host before symlink and platform-alias collapse.
    pub fn requested_path(&self) -> &Path {
        self.requested.as_path()
    }

    /// Returns the canonical directory used for identity, containment, and filesystem access.
    pub fn canonical_path(&self) -> &Path {
        &self.canonical
    }

    /// Physical identity retained while this directory handle remains alive.
    pub fn object_identity(&self) -> [u64; 2] {
        self.object
    }

    /// Checks whether the canonical name still denotes the opened directory object.
    pub fn ensure_current(&self) -> Result<(), DirPathError> {
        let current =
            cap_std::fs::Dir::open_ambient_dir(&self.canonical, cap_std::ambient_authority())
                .and_then(|handle| object_identity(&handle));
        if self.active.load(std::sync::atomic::Ordering::Acquire)
            && current.ok() == Some(self.object)
        {
            Ok(())
        } else {
            self.active
                .store(false, std::sync::atomic::Ordering::Release);
            Err(DirPathError::RootUnavailable {
                path: self.canonical.clone(),
                message: "directory binding changed".into(),
            })
        }
    }

    /// Open handle used for directory-relative I/O; paths must never be reopened ambiently.
    pub fn handle(&self) -> &cap_std::fs::Dir {
        &self.handle
    }

    /// Serializes conditional writes for every handle referring to this physical root.
    pub fn lock_writes(&self) -> std::sync::LockResult<std::sync::MutexGuard<'_, ()>> {
        self.writes.lock()
    }

    /// Resolves an existing relative path after following symlinks and proving containment.
    pub fn resolve_existing(
        &self,
        relative_path: impl AsRef<Path>,
    ) -> Result<PathBuf, DirPathError> {
        let relative_path = relative_path.as_ref();
        let candidate = self.candidate(relative_path)?;
        let canonical =
            dunce::canonicalize(&candidate).map_err(|error| DirPathError::RootUnavailable {
                path: candidate,
                message: error.to_string(),
            })?;
        self.ensure_contained(canonical)
    }

    /// Resolves a relative write target while checking its nearest existing ancestor.
    ///
    /// This authorizations creating a new file but rejects lexical escapes and existing parent symlinks
    /// that leave the directory boundary.
    pub fn resolve_for_write(
        &self,
        relative_path: impl AsRef<Path>,
    ) -> Result<PathBuf, DirPathError> {
        let relative_path = relative_path.as_ref();
        let candidate = self.candidate(relative_path)?;
        if candidate.exists() {
            return self.resolve_existing(relative_path);
        }

        let mut existing_parent = candidate.as_path();
        while !existing_parent.exists() {
            existing_parent = existing_parent
                .parent()
                .ok_or_else(|| DirPathError::InvalidRelativePath(relative_path.to_path_buf()))?;
        }
        let canonical_parent = dunce::canonicalize(existing_parent).map_err(|error| {
            DirPathError::RootUnavailable {
                path: existing_parent.to_path_buf(),
                message: error.to_string(),
            }
        })?;
        self.ensure_contained(canonical_parent)?;
        Ok(candidate)
    }

    /// Projects an observed absolute path into this directory's relative namespace.
    ///
    /// Both the requested and canonical root aliases are accepted. The method intentionally does
    /// not canonicalize the observed path because removal events commonly refer to paths that no
    /// longer exist.
    pub fn project_observed_path(&self, path: impl AsRef<Path>) -> Option<PathBuf> {
        let path = path.as_ref();
        path.strip_prefix(&self.requested)
            .or_else(|_| path.strip_prefix(&self.canonical))
            .ok()
            .map(Path::to_path_buf)
    }

    /// Returns this root relative to an existing canonical ancestor.
    ///
    /// Git uses this result when the directory is nested below a repository worktree.
    pub fn relative_to_existing_ancestor(
        &self,
        ancestor: impl AsRef<Path>,
    ) -> Result<PathBuf, DirPathError> {
        let ancestor = ancestor.as_ref();
        let canonical_ancestor =
            dunce::canonicalize(ancestor).map_err(|error| DirPathError::RootUnavailable {
                path: ancestor.to_path_buf(),
                message: error.to_string(),
            })?;
        self.canonical
            .strip_prefix(&canonical_ancestor)
            .map(Path::to_path_buf)
            .map_err(|_| DirPathError::OutsideDir(canonical_ancestor))
    }

    fn candidate(&self, relative_path: &Path) -> Result<PathBuf, DirPathError> {
        self.ensure_current()?;
        if relative_path.as_os_str().is_empty() {
            return Ok(self.canonical.clone());
        }
        path_utils::join_descendant(&self.canonical, relative_path)
            .map_err(|_| DirPathError::InvalidRelativePath(relative_path.to_path_buf()))
    }

    fn ensure_contained(&self, canonical: PathBuf) -> Result<PathBuf, DirPathError> {
        if canonical.starts_with(&self.canonical) {
            Ok(canonical)
        } else {
            Err(DirPathError::OutsideDir(canonical))
        }
    }
}

#[cfg(unix)]
fn object_identity(handle: &cap_std::fs::Dir) -> std::io::Result<[u64; 2]> {
    use std::os::unix::fs::MetadataExt;
    let metadata = handle.try_clone()?.into_std_file().metadata()?;
    Ok([metadata.dev(), metadata.ino()])
}

#[cfg(windows)]
fn object_identity(handle: &cap_std::fs::Dir) -> std::io::Result<[u64; 2]> {
    let file = handle.try_clone()?.into_std_file();
    let information = winapi_util::file::information(&file)?;
    Ok([information.volume_serial_number(), information.file_index()])
}

fn directory_write_lock(object: [u64; 2]) -> Arc<std::sync::Mutex<()>> {
    type Locks = std::collections::BTreeMap<[u64; 2], std::sync::Weak<std::sync::Mutex<()>>>;
    static LOCKS: std::sync::OnceLock<std::sync::Mutex<Locks>> = std::sync::OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    locks.retain(|_, lock| lock.strong_count() != 0);
    if let Some(lock) = locks.get(&object).and_then(std::sync::Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(std::sync::Mutex::new(()));
    locks.insert(object, Arc::downgrade(&lock));
    lock
}
