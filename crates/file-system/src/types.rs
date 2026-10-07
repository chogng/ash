/// Stable entry kind shared across local and future remote filesystems.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileType {
    Directory,
    File,
    SymbolicLink,
    Other,
}

/// Metadata for one existing directory path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileMetadata {
    pub file_type: FileType,
    pub size_bytes: u64,
    pub readonly: bool,
    pub modified_at_millis: Option<u64>,
}

/// File bytes paired with the opaque revision that a later conditional write must present.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileContent {
    pub bytes: Vec<u8>,
    pub revision: String,
}

/// A prepared file mutation whose source bytes must still have the given revision.
/// Creation and move destinations must be absent, including empty files.
pub enum FileMutation {
    Create {
        path: std::path::PathBuf,
        content: Vec<u8>,
    },
    Replace {
        path: std::path::PathBuf,
        content: Vec<u8>,
        expected_revision: String,
    },
    Remove {
        path: std::path::PathBuf,
        expected_revision: String,
    },
    MoveAndReplace {
        path: std::path::PathBuf,
        target: std::path::PathBuf,
        content: Vec<u8>,
        expected_revision: String,
    },
}

/// A batch failure records completed paths and whether publication has begun.
/// An I/O error during publication can occur after the filesystem changed.
#[derive(Debug)]
pub struct FileMutationError {
    pub source: FileSystemError,
    pub completed_paths: Vec<std::path::PathBuf>,
    pub publication_started: bool,
}

impl std::fmt::Display for FileMutationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.source.fmt(formatter)?;
        if self.publication_started {
            write!(formatter, "; published paths: {:?}", self.completed_paths)?;
        }
        Ok(())
    }
}

impl std::error::Error for FileMutationError {}

use crate::FileSystemError;

/// Explicit write condition for callers that must not overwrite a newer file revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FileWriteCondition {
    Unconditional,
    ExpectedRevision(String),
    /// Publish only to a missing or empty file without replacing an intervening writer's bytes.
    MissingOrEmpty,
    /// Combines publication policy and revision validation under the storage publication lock.
    Options {
        mode: FileWriteMode,
        expected_revision: Option<String>,
    },
}

/// Determines whether publication may create a path, replace it, or do either.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileWriteMode {
    Create,
    Replace,
    CreateOrReplace,
}

/// Behavior when a create or rename target already exists.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExistingTargetBehavior {
    Error,
    Overwrite,
    Ignore,
}

/// Behavior when a delete target does not exist.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MissingTargetBehavior {
    Error,
    Ignore,
}

/// Scope of one delete operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileDeleteMode {
    FileOrEmptyDirectory,
    Recursive,
}

/// Produces the stable opaque revision for one exact sequence of file bytes.
pub fn file_revision(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut revision = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(revision, "{byte:02x}");
    }
    revision
}

/// One direct child returned by a directory read.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectoryEntry {
    pub name: String,
    pub file_type: FileType,
}
use sha2::Digest;
use sha2::Sha256;
