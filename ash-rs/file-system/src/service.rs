use crate::DirectoryEntry;
use crate::ExistingTargetBehavior;
use crate::FileContent;
use crate::FileDeleteMode;
use crate::FileMetadata;
use crate::FileSystemError;
use crate::FileWriteCondition;
use crate::MissingTargetBehavior;
use std::path::Path;

/// Directory-scoped filesystem access used by both client adapters and Agent tools.
///
/// Implementations must resolve every relative input beneath their configured authority root and
/// must reject absolute paths, parent traversal, and symlink escapes before performing I/O.
pub trait FileSystem: Send + Sync {
    /// Checks the requested action against this service's subject and directory grant.
    /// Every I/O entry must also validate its exact permission under the revocation lease.
    fn ensure_permission(
        &self,
        permission: ash_file_access::Permission,
    ) -> Result<(), FileSystemError>;

    /// Reads one existing file, failing if its content exceeds `maximum_bytes`.
    fn read_file(&self, path: &Path, maximum_bytes: usize) -> Result<Vec<u8>, FileSystemError>;

    /// Reads file bytes with the opaque revision required by a conditional write.
    fn read_file_with_revision(
        &self,
        path: &Path,
        maximum_bytes: usize,
    ) -> Result<FileContent, FileSystemError>;

    /// Atomically replaces or creates one file, failing if `content` exceeds `maximum_bytes`.
    fn write_file(
        &self,
        path: &Path,
        content: &[u8],
        maximum_bytes: usize,
    ) -> Result<FileMetadata, FileSystemError>;

    /// Writes only when the requested condition matches.
    ///
    /// Implementations must serialize revision checks with replacement across service instances.
    /// `MissingOrEmpty` must check the target during publication and must not replace a file
    /// that another process creates or fills after the caller's inspection.
    fn write_file_with_condition(
        &self,
        path: &Path,
        content: &[u8],
        maximum_bytes: usize,
        condition: &FileWriteCondition,
    ) -> Result<FileMetadata, FileSystemError>;

    /// Returns metadata for one existing path.
    fn get_metadata(&self, path: &Path) -> Result<FileMetadata, FileSystemError>;

    /// Lists the direct children of one existing directory.
    fn read_directory(&self, path: &Path) -> Result<Vec<DirectoryEntry>, FileSystemError>;

    /// Creates an empty file according to the explicit existing-target behavior.
    fn create_file(
        &self,
        path: &Path,
        existing: ExistingTargetBehavior,
    ) -> Result<FileMetadata, FileSystemError>;

    /// Creates a directory and its missing parents. Requires WriteFiles.
    fn create_directory(&self, path: &Path) -> Result<FileMetadata, FileSystemError>;

    /// Renames one directory resource according to the explicit destination behavior.
    fn rename(
        &self,
        source: &Path,
        target: &Path,
        existing: ExistingTargetBehavior,
    ) -> Result<(), FileSystemError>;

    /// Deletes one directory resource according to the explicit missing-target behavior and scope.
    fn delete(
        &self,
        path: &Path,
        missing: MissingTargetBehavior,
        mode: FileDeleteMode,
    ) -> Result<(), FileSystemError>;
}
