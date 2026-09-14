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

/// Explicit write condition for callers that must not overwrite a newer file revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FileWriteCondition {
    Unconditional,
    ExpectedRevision(String),
    /// Publish only to a missing or empty file without replacing an intervening writer's bytes.
    MissingOrEmpty,
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
