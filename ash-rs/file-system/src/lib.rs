//! Directory-confined filesystem primitives shared by clients and tools.

mod error;
mod find_up;
mod local;
mod service;
mod types;

pub use error::FileSystemError;
pub use find_up::{FindUpErrorPolicy, find_nearest_ancestor_with_markers};
pub use local::LocalFileSystem;
pub use service::FileSystem;
pub use service::SystemFileTransferOperation;
pub use types::file_revision;
pub use types::{
    DirectoryEntry, ExistingTargetBehavior, FileContent, FileDeleteMode, FileMetadata, FileType,
    FileWriteCondition, MissingTargetBehavior,
};
