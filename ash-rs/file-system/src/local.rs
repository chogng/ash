use crate::DirectoryEntry;
use crate::ExistingTargetBehavior;
use crate::FileContent;
use crate::FileDeleteMode;
use crate::FileMetadata;
use crate::FileSystem;
use crate::FileSystemError;
use crate::FileType;
use crate::FileWriteCondition;
use crate::MissingTargetBehavior;
use crate::file_revision;
use ash_file_access::Authorization;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::Permission;
use cap_std::fs::Dir as Directory;
use cap_std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Filesystem bound to an explicitly granted subject and directory.
/// Every entry obtains and validates the exact action authorization before performing I/O.
pub struct LocalFileSystem {
    files: ScopedFiles,
    authority: Authority,
}

enum Authority {
    Grant(Grant),
    Authorization(Authorization),
}

impl LocalFileSystem {
    pub fn new(grant: Grant) -> Self {
        Self {
            files: ScopedFiles::new(grant.dir().clone()),
            authority: Authority::Grant(grant),
        }
    }

    pub fn from_authorization(authorization: Authorization) -> Self {
        Self {
            files: ScopedFiles::new(authorization.dir().clone()),
            authority: Authority::Authorization(authorization),
        }
    }

    fn execute<T>(
        &self,
        permission: Permission,
        operation: impl FnOnce(&ScopedFiles) -> Result<T, FileSystemError>,
    ) -> Result<T, FileSystemError> {
        let authorization = match &self.authority {
            Authority::Grant(grant) => grant
                .authorize(permission)
                .map_err(|error| FileSystemError::PermissionDenied(error.to_string()))?,
            Authority::Authorization(authorization) => authorization.clone(),
        };
        authorization
            .execute(authorization.subject(), &self.files.dir, permission, || {
                operation(&self.files)
            })
            .map_err(|error| FileSystemError::PermissionDenied(error.to_string()))?
    }
}

impl FileSystem for LocalFileSystem {
    fn create_directory(&self, path: &Path) -> Result<FileMetadata, FileSystemError> {
        self.execute(Permission::WriteFiles, |files| {
            let _guard = files
                .dir
                .directory()
                .lock_writes()
                .map_err(|error| FileSystemError::Io(error.to_string()))?;
            let path = files.resolve_for_write(path)?;
            files.handle().create_dir_all(&path).map_err(io_error)?;
            metadata(files.handle(), &path)
        })
    }

    fn ensure_permission(&self, permission: Permission) -> Result<(), FileSystemError> {
        self.execute(permission, |_| Ok(()))
    }

    fn read_file(&self, path: &Path, maximum_bytes: usize) -> Result<Vec<u8>, FileSystemError> {
        self.execute(Permission::ReadFiles, |files| {
            files.read_file(path, maximum_bytes)
        })
    }
    fn read_file_with_revision(
        &self,
        path: &Path,
        maximum_bytes: usize,
    ) -> Result<FileContent, FileSystemError> {
        self.execute(Permission::ReadFiles, |files| {
            files.read_file_with_revision(path, maximum_bytes)
        })
    }
    fn write_file(
        &self,
        path: &Path,
        content: &[u8],
        maximum_bytes: usize,
    ) -> Result<FileMetadata, FileSystemError> {
        self.execute(Permission::WriteFiles, |files| {
            files.write_file(path, content, maximum_bytes)
        })
    }
    fn write_file_with_condition(
        &self,
        path: &Path,
        content: &[u8],
        maximum_bytes: usize,
        condition: &FileWriteCondition,
    ) -> Result<FileMetadata, FileSystemError> {
        self.execute(Permission::WriteFiles, |files| {
            files.write_file_with_condition(path, content, maximum_bytes, condition)
        })
    }
    fn get_metadata(&self, path: &Path) -> Result<FileMetadata, FileSystemError> {
        self.execute(Permission::BrowseFiles, |files| files.get_metadata(path))
    }
    fn read_directory(&self, path: &Path) -> Result<Vec<DirectoryEntry>, FileSystemError> {
        self.execute(Permission::BrowseFiles, |files| files.read_directory(path))
    }
    fn create_file(
        &self,
        path: &Path,
        existing: ExistingTargetBehavior,
    ) -> Result<FileMetadata, FileSystemError> {
        self.execute(Permission::WriteFiles, |files| {
            files.create_file(path, existing)
        })
    }
    fn rename(
        &self,
        source: &Path,
        target: &Path,
        existing: ExistingTargetBehavior,
    ) -> Result<(), FileSystemError> {
        self.execute(Permission::WriteFiles, |files| {
            files.rename(source, target, existing)
        })
    }
    fn delete(
        &self,
        path: &Path,
        missing: MissingTargetBehavior,
        mode: FileDeleteMode,
    ) -> Result<(), FileSystemError> {
        self.execute(Permission::WriteFiles, |files| {
            files.delete(path, missing, mode)
        })
    }
}

/// Local implementation that confines all operations to one canonical directory.
struct ScopedFiles {
    dir: Dir,
}

impl ScopedFiles {
    pub fn new(dir: Dir) -> Self {
        Self { dir }
    }

    fn resolve_existing(&self, path: &Path) -> Result<PathBuf, FileSystemError> {
        match self.dir.resolve_existing(path) {
            Ok(resolved) => self.relative(resolved),
            Err(_) => match self.dir.resolve_for_write(path) {
                Ok(candidate) if candidate.try_exists().map_err(io_error)? => {
                    Err(FileSystemError::InvalidPath(path.to_path_buf()))
                }
                Ok(_) => Err(FileSystemError::NotFound(path.to_path_buf())),
                Err(_) => Err(FileSystemError::InvalidPath(path.to_path_buf())),
            },
        }
    }

    fn resolve_for_write(&self, path: &Path) -> Result<PathBuf, FileSystemError> {
        let resolved = self
            .dir
            .resolve_for_write(path)
            .map_err(|_| FileSystemError::InvalidPath(path.to_path_buf()))?;
        self.relative(resolved)
    }

    fn handle(&self) -> &Directory {
        self.dir.directory().handle()
    }

    fn relative(&self, path: PathBuf) -> Result<PathBuf, FileSystemError> {
        path.strip_prefix(self.dir.canonical_path())
            .map(|path| {
                if path.as_os_str().is_empty() {
                    PathBuf::from(".")
                } else {
                    path.to_path_buf()
                }
            })
            .map_err(|_| FileSystemError::InvalidPath(path))
    }

    fn write_file_inner(
        &self,
        path: &Path,
        content: &[u8],
        maximum_bytes: usize,
    ) -> Result<FileMetadata, FileSystemError> {
        if content.len() > maximum_bytes {
            return Err(FileSystemError::WriteLimitExceeded { maximum_bytes });
        }
        let resolved = self.resolve_for_write(path)?;
        let existing_metadata = match self.handle().metadata(&resolved) {
            Ok(metadata) => {
                if !metadata.is_file() {
                    return Err(FileSystemError::NotFile(path.to_path_buf()));
                }
                if metadata.permissions().readonly() {
                    return Err(FileSystemError::ReadOnly(path.to_path_buf()));
                }
                Some(metadata)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(io_error(error)),
        };
        let parent = resolved
            .parent()
            .ok_or_else(|| FileSystemError::InvalidPath(path.to_path_buf()))?;
        let parent = if parent.as_os_str().is_empty() {
            Path::new(".")
        } else {
            parent
        };
        let parent_metadata = self.handle().metadata(parent).map_err(io_error)?;
        if !parent_metadata.is_dir() {
            return Err(FileSystemError::NotDirectory(
                path.parent().unwrap_or(Path::new("")).to_path_buf(),
            ));
        }
        atomic_write(
            self.handle(),
            &resolved,
            content,
            existing_metadata
                .as_ref()
                .map(cap_std::fs::Metadata::permissions),
        )
        .map_err(io_error)?;
        metadata(self.handle(), &resolved)
    }
}

impl ScopedFiles {
    fn read_file(&self, path: &Path, maximum_bytes: usize) -> Result<Vec<u8>, FileSystemError> {
        if maximum_bytes == 0 {
            return Err(FileSystemError::ReadLimitExceeded { maximum_bytes });
        }
        let resolved = self.resolve_existing(path)?;
        let mut file = self.handle().open(resolved).map_err(io_error)?;
        let mut bytes = Vec::with_capacity(maximum_bytes.min(8 * 1024));
        Read::by_ref(&mut file)
            .take((maximum_bytes + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        if bytes.len() > maximum_bytes {
            return Err(FileSystemError::ReadLimitExceeded { maximum_bytes });
        }
        Ok(bytes)
    }

    fn write_file(
        &self,
        path: &Path,
        content: &[u8],
        maximum_bytes: usize,
    ) -> Result<FileMetadata, FileSystemError> {
        let _guard = self
            .dir
            .directory()
            .lock_writes()
            .map_err(|_| FileSystemError::Io("directory write lock is poisoned".into()))?;
        self.write_file_inner(path, content, maximum_bytes)
    }

    fn read_file_with_revision(
        &self,
        path: &Path,
        maximum_bytes: usize,
    ) -> Result<FileContent, FileSystemError> {
        let bytes = self.read_file(path, maximum_bytes)?;
        Ok(FileContent {
            revision: file_revision(&bytes),
            bytes,
        })
    }

    fn write_file_with_condition(
        &self,
        path: &Path,
        content: &[u8],
        maximum_bytes: usize,
        condition: &FileWriteCondition,
    ) -> Result<FileMetadata, FileSystemError> {
        let _guard = self
            .dir
            .directory()
            .lock_writes()
            .map_err(|_| FileSystemError::Io("directory write lock is poisoned".into()))?;
        if let FileWriteCondition::ExpectedRevision(expected) = condition {
            let current = self.read_file(path, maximum_bytes)?;
            if file_revision(&current) != *expected {
                return Err(FileSystemError::RevisionConflict(path.to_path_buf()));
            }
        }
        self.write_file_inner(path, content, maximum_bytes)
    }

    fn get_metadata(&self, path: &Path) -> Result<FileMetadata, FileSystemError> {
        let resolved = self.resolve_existing(path)?;
        metadata(self.handle(), &resolved)
    }

    fn read_directory(&self, path: &Path) -> Result<Vec<DirectoryEntry>, FileSystemError> {
        let resolved = self.resolve_existing(path)?;
        if !self.handle().is_dir(&resolved) {
            return Err(FileSystemError::NotDirectory(path.to_path_buf()));
        }
        let mut entries = self
            .handle()
            .read_dir(resolved)
            .map_err(io_error)?
            .map(|entry| {
                let entry = entry.map_err(io_error)?;
                let entry_type = entry.file_type().map_err(io_error)?;
                Ok(DirectoryEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    file_type: file_type(entry_type),
                })
            })
            .collect::<Result<Vec<_>, FileSystemError>>()?;
        entries.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(entries)
    }

    fn create_file(
        &self,
        path: &Path,
        existing: ExistingTargetBehavior,
    ) -> Result<FileMetadata, FileSystemError> {
        let _guard = self
            .dir
            .directory()
            .lock_writes()
            .map_err(|_| FileSystemError::Io("directory write lock is poisoned".into()))?;
        let resolved = self.resolve_for_write(path)?;
        if self.handle().try_exists(&resolved).map_err(io_error)? {
            return match existing {
                ExistingTargetBehavior::Error => {
                    Err(FileSystemError::AlreadyExists(path.to_path_buf()))
                }
                ExistingTargetBehavior::Ignore => metadata(self.handle(), &resolved),
                ExistingTargetBehavior::Overwrite => self.write_file_inner(path, &[], 1),
            };
        }
        self.write_file_inner(path, &[], 1)
    }

    fn rename(
        &self,
        source: &Path,
        target: &Path,
        existing: ExistingTargetBehavior,
    ) -> Result<(), FileSystemError> {
        let _guard = self
            .dir
            .directory()
            .lock_writes()
            .map_err(|_| FileSystemError::Io("directory write lock is poisoned".into()))?;
        let source_path = self.resolve_existing(source)?;
        let target_path = self.resolve_for_write(target)?;
        if source_path == target_path {
            return Ok(());
        }
        if self.handle().try_exists(&target_path).map_err(io_error)? {
            match existing {
                ExistingTargetBehavior::Error => {
                    return Err(FileSystemError::AlreadyExists(target.to_path_buf()));
                }
                ExistingTargetBehavior::Ignore => return Ok(()),
                ExistingTargetBehavior::Overwrite => {
                    let backup = rename_backup_path(self.handle(), &target_path)?;
                    self.handle()
                        .rename(&target_path, self.handle(), &backup)
                        .map_err(io_error)?;
                    if let Err(error) =
                        self.handle()
                            .rename(&source_path, self.handle(), &target_path)
                    {
                        let _ = self.handle().rename(&backup, self.handle(), &target_path);
                        return Err(io_error(error));
                    }
                    let _ = remove_resource(self.handle(), &backup, FileDeleteMode::Recursive);
                    return Ok(());
                }
            }
        }
        let parent = target_path
            .parent()
            .ok_or_else(|| FileSystemError::InvalidPath(target.to_path_buf()))?;
        let parent = if parent.as_os_str().is_empty() {
            Path::new(".")
        } else {
            parent
        };
        if !self.handle().is_dir(parent) {
            return Err(FileSystemError::NotDirectory(
                target.parent().unwrap_or(Path::new("")).to_path_buf(),
            ));
        }
        self.handle()
            .rename(source_path, self.handle(), target_path)
            .map_err(io_error)
    }

    fn delete(
        &self,
        path: &Path,
        missing: MissingTargetBehavior,
        mode: FileDeleteMode,
    ) -> Result<(), FileSystemError> {
        let _guard = self
            .dir
            .directory()
            .lock_writes()
            .map_err(|_| FileSystemError::Io("directory write lock is poisoned".into()))?;
        let candidate = self.resolve_for_write(path)?;
        if !self.handle().try_exists(&candidate).map_err(io_error)? {
            return match missing {
                MissingTargetBehavior::Error => Err(FileSystemError::NotFound(path.to_path_buf())),
                MissingTargetBehavior::Ignore => Ok(()),
            };
        }
        let resolved = self.resolve_existing(path)?;
        remove_resource(self.handle(), &resolved, mode)
    }
}

fn rename_backup_path(dir: &Directory, target: &Path) -> Result<PathBuf, FileSystemError> {
    let parent = target
        .parent()
        .ok_or_else(|| FileSystemError::InvalidPath(target.to_path_buf()))?;
    for sequence in 0..1_024u32 {
        let candidate = parent.join(format!(
            ".ash-rename-backup-{}-{sequence}",
            std::process::id()
        ));
        if !dir.try_exists(&candidate).map_err(io_error)? {
            return Ok(candidate);
        }
    }
    Err(FileSystemError::Io(
        "could not allocate a directory rename backup path".into(),
    ))
}

fn remove_resource(
    dir: &Directory,
    path: &Path,
    mode: FileDeleteMode,
) -> Result<(), FileSystemError> {
    let metadata = dir.symlink_metadata(path).map_err(io_error)?;
    if metadata.file_type().is_dir() {
        match mode {
            FileDeleteMode::FileOrEmptyDirectory => dir.remove_dir(path).map_err(io_error),
            FileDeleteMode::Recursive => dir.remove_dir_all(path).map_err(io_error),
        }
    } else {
        dir.remove_file(path).map_err(io_error)
    }
}

fn atomic_write(
    root: &Directory,
    target: &Path,
    content: &[u8],
    permissions: Option<cap_std::fs::Permissions>,
) -> std::io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| std::io::Error::other("write target has no parent"))?;
    let parent = root.open_dir(if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    })?;
    let target = target
        .file_name()
        .ok_or_else(|| std::io::Error::other("write target has no file name"))?;
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let (name, mut temporary) = loop {
        let name = format!(
            ".ash-write-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        match parent.open_with(&name, OpenOptions::new().write(true).create_new(true)) {
            Ok(file) => break (name, file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    };
    let result = (|| {
        temporary.write_all(content)?;
        if let Some(permissions) = permissions {
            temporary.set_permissions(permissions)?;
        }
        temporary.sync_all()?;
        parent.rename(&name, &parent, target)?;
        #[cfg(unix)]
        parent.try_clone()?.into_std_file().sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = parent.remove_file(&name);
    }
    result
}

fn metadata(dir: &Directory, path: &Path) -> Result<FileMetadata, FileSystemError> {
    let metadata = dir.symlink_metadata(path).map_err(io_error)?;
    Ok(FileMetadata {
        file_type: file_type(metadata.file_type()),
        size_bytes: metadata.len(),
        readonly: metadata.permissions().readonly(),
        modified_at_millis: metadata
            .modified()
            .ok()
            .and_then(|modified| modified.into_std().duration_since(UNIX_EPOCH).ok())
            .and_then(|duration| u64::try_from(duration.as_millis()).ok()),
    })
}

fn file_type(file_type: cap_std::fs::FileType) -> FileType {
    if file_type.is_dir() {
        FileType::Directory
    } else if file_type.is_file() {
        FileType::File
    } else if file_type.is_symlink() {
        FileType::SymbolicLink
    } else {
        FileType::Other
    }
}

fn io_error(error: std::io::Error) -> FileSystemError {
    FileSystemError::Io(error.to_string())
}

#[cfg(test)]
#[path = "local_tests.rs"]
mod tests;
