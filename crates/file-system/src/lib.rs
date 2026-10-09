//! Directory-confined filesystem primitives shared by clients and tools.

mod elevated;
mod error;
mod find_up;
mod local;
mod path_case_sensitivity;
mod service;
mod text_document;
mod text_file;
mod types;

pub use elevated::ELEVATED_FILE_WRITE_ARGUMENT;
pub use elevated::run_elevated_file_helper;
pub use error::FileSystemError;
pub use find_up::{FindUpErrorPolicy, find_nearest_ancestor_with_markers};
pub use local::LocalFileSystem;
pub use local::commit_file_mutations;
pub use service::FileSystem;
pub use service::SystemFileTransferOperation;
pub use text_document::{
    FileTextDocuments, TextDocumentChange, TextDocumentContent, TextDocumentEditor,
    TextDocumentError, TextDocumentSnapshot,
};
pub use text_file::TextFileFormat;
pub use types::FileMutation;
pub use types::FileMutationError;
pub use types::FileWriteMode;
pub use types::PathCaseSensitivity;
pub use types::PathCaseSensitivityScope;
pub use types::file_revision;
pub use types::{
    DirectoryEntry, ExistingTargetBehavior, FileContent, FileDeleteMode, FileMetadata, FileType,
    FileWriteCondition, MissingTargetBehavior,
};
