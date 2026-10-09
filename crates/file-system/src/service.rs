use crate::DirectoryEntry;
use crate::ExistingTargetBehavior;
use crate::FileContent;
use crate::FileDeleteMode;
use crate::FileMetadata;
use crate::FileSystemError;
use crate::FileWriteCondition;
use crate::MissingTargetBehavior;
use crate::PathCaseSensitivityScope;
use std::any::Any;
use std::path::Path;

/// File operation requested by a paste action or recorded on the system clipboard.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SystemFileTransferOperation {
    Copy,
    Move,
}

/// Directory-scoped filesystem access used by both client adapters and Agent tools.
///
/// Implementations must resolve every relative input beneath their configured authority root and
/// must reject absolute paths, parent traversal, and symlink escapes before performing I/O.
pub trait FileSystem: Send + Sync {
    fn as_any(&self) -> &dyn Any;

    /// Copies a file or directory between granted roots without loading its contents into a protocol message.
    fn copy_to(
        &self,
        source: &Path,
        destination: &dyn FileSystem,
        target: &Path,
    ) -> Result<(), FileSystemError>;
    /// Copies or moves files named by the system clipboard into a granted directory.
    /// Finder uses the requested operation; Linux and Windows read it from the clipboard.
    fn paste_system_files(
        &self,
        directory: &Path,
        requested_operation: SystemFileTransferOperation,
    ) -> Result<bool, FileSystemError>;
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

    /// Observes lookup rules along a relative path, including its existing parent for a new file.
    /// Each scope applies only to direct children. Unsupported filesystems report Unknown.
    fn read_path_case_sensitivity(
        &self,
        path: &Path,
    ) -> Result<Vec<PathCaseSensitivityScope>, FileSystemError>;

    /// Lists the direct children of one existing directory.
    fn read_directory(&self, path: &Path) -> Result<Vec<DirectoryEntry>, FileSystemError>;

    /// Creates an empty file and its missing parent directories according to the explicit
    /// existing-target behavior. Requires WriteFiles.
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
