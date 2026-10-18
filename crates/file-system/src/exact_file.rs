use crate::DirectoryEntry;
use crate::ExistingTargetBehavior;
use crate::FileContent;
use crate::FileDeleteMode;
use crate::FileMetadata;
use crate::FileSystem;
use crate::FileSystemError;
use crate::FileType;
use crate::FileWriteCondition;
use crate::LocalFileSystem;
use crate::MissingTargetBehavior;
use crate::PathCaseSensitivityScope;
use crate::SystemFileTransferOperation;
use ash_file_access::Grant;
use ash_file_access::PathAccessPolicy;
use ash_file_access::Permission;
use std::any::Any;
use std::path::Path;

/// A revocable exact-file proof with read and atomic publication only.
/// Directory and transfer operations remain unavailable even if the selected file is replaced
/// by a directory later. A path ceiling alone cannot safely authorize recursive operations.
pub struct ExactFileSystem {
    inner: LocalFileSystem,
}

impl ExactFileSystem {
    pub fn new(grant: Grant, relative: &Path) -> Result<Self, FileSystemError> {
        let policy = PathAccessPolicy::for_exact_file(relative)
            .map_err(FileSystemError::PermissionDenied)?;
        let files = Self {
            inner: LocalFileSystem::new(grant.with_path_policy(policy)),
        };
        files.get_metadata(relative)?;
        Ok(files)
    }

    fn denied<T>() -> Result<T, FileSystemError> {
        Err(FileSystemError::PermissionDenied(
            "exact file access permits only file reads and writes".into(),
        ))
    }

    fn ensure_file(&self, path: &Path) -> Result<FileMetadata, FileSystemError> {
        let metadata = self.inner.get_metadata(path)?;
        if metadata.file_type != FileType::File {
            return Self::denied();
        }
        Ok(metadata)
    }

    fn ensure_write_target(&self, path: &Path) -> Result<(), FileSystemError> {
        match self.ensure_file(path) {
            Ok(_) | Err(FileSystemError::NotFound(_)) => Ok(()),
            Err(error) => Err(error),
        }
    }
}

impl FileSystem for ExactFileSystem {
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn ensure_permission(&self, permission: Permission) -> Result<(), FileSystemError> {
        self.inner.ensure_permission(permission)
    }
    fn read_file(&self, path: &Path, maximum_bytes: usize) -> Result<Vec<u8>, FileSystemError> {
        self.ensure_file(path)?;
        self.inner.read_file(path, maximum_bytes)
    }
    fn read_file_with_revision(
        &self,
        path: &Path,
        maximum_bytes: usize,
    ) -> Result<FileContent, FileSystemError> {
        self.ensure_file(path)?;
        self.inner.read_file_with_revision(path, maximum_bytes)
    }
    fn write_file(
        &self,
        path: &Path,
        content: &[u8],
        maximum_bytes: usize,
    ) -> Result<FileMetadata, FileSystemError> {
        self.ensure_write_target(path)?;
        self.inner.write_file(path, content, maximum_bytes)
    }
    fn write_file_with_condition(
        &self,
        path: &Path,
        content: &[u8],
        maximum_bytes: usize,
        condition: &FileWriteCondition,
    ) -> Result<FileMetadata, FileSystemError> {
        self.ensure_write_target(path)?;
        self.inner
            .write_file_with_condition(path, content, maximum_bytes, condition)
    }
    fn get_metadata(&self, path: &Path) -> Result<FileMetadata, FileSystemError> {
        self.ensure_file(path)
    }
    fn read_path_case_sensitivity(
        &self,
        path: &Path,
    ) -> Result<Vec<PathCaseSensitivityScope>, FileSystemError> {
        self.ensure_file(path)?;
        self.inner.read_path_case_sensitivity(path)
    }
    fn read_directory(&self, _: &Path) -> Result<Vec<DirectoryEntry>, FileSystemError> {
        Self::denied()
    }
    fn create_file(
        &self,
        _: &Path,
        _: ExistingTargetBehavior,
    ) -> Result<FileMetadata, FileSystemError> {
        Self::denied()
    }
    fn create_directory(&self, _: &Path) -> Result<FileMetadata, FileSystemError> {
        Self::denied()
    }
    fn rename(&self, _: &Path, _: &Path, _: ExistingTargetBehavior) -> Result<(), FileSystemError> {
        Self::denied()
    }
    fn delete(
        &self,
        _: &Path,
        _: MissingTargetBehavior,
        _: FileDeleteMode,
    ) -> Result<(), FileSystemError> {
        Self::denied()
    }
    fn copy_to(&self, _: &Path, _: &dyn FileSystem, _: &Path) -> Result<(), FileSystemError> {
        Self::denied()
    }
    fn paste_system_files(
        &self,
        _: &Path,
        _: SystemFileTransferOperation,
    ) -> Result<bool, FileSystemError> {
        Self::denied()
    }
}

#[cfg(test)]
#[path = "exact_file_tests.rs"]
mod tests;
