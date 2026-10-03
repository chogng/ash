//! Directory-confined filesystem primitives shared by clients and tools.

mod error;
mod find_up;
mod local;
mod service;
mod text_file;
mod types;

pub use error::FileSystemError;
pub use find_up::{FindUpErrorPolicy, find_nearest_ancestor_with_markers};
pub use local::LocalFileSystem;
pub use local::commit_file_mutations;
pub use service::FileSystem;
pub use service::SystemFileTransferOperation;
pub use text_file::TextFileFormat;
pub use types::FileMutation;
pub use types::FileMutationError;
pub use types::file_revision;
pub use types::{
    DirectoryEntry, ExistingTargetBehavior, FileContent, FileDeleteMode, FileMetadata, FileType,
    FileWriteCondition, MissingTargetBehavior,
};
