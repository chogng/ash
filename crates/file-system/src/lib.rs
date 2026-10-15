//! Directory-confined filesystem primitives shared by clients and tools.

mod elevated;
mod error;
mod find_up;
mod local;
mod path_case_sensitivity;
mod removal;
mod service;
mod text_document;
mod text_encoding;
mod text_file;
mod types;

pub use elevated::ELEVATED_FILE_WRITE_ARGUMENT;
pub use elevated::run_elevated_file_helper;
pub use error::FileSystemError;
pub use find_up::{FindUpErrorPolicy, find_nearest_ancestor_with_markers};
pub use local::FileReadSnapshot;
pub use local::LocalFileSystem;
pub use local::commit_file_mutations;
pub use service::FileSystem;
pub use service::SystemFileTransferOperation;
pub use text_document::{
    AuthorizedTextDocuments, FileTextDocuments, TextDocumentChange, TextDocumentContent,
    TextDocumentEditor, TextDocumentError, TextDocumentSnapshot,
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

pub use text_encoding::DecodedText;
pub use text_encoding::TextDecodingOptions;
pub use text_encoding::TextEncodingError;
pub use text_encoding::decode_text;
pub use text_encoding::decode_text_with_options;
pub use text_encoding::encode_text;

pub use removal::FileRemoval;
pub use removal::FileRemovalMode;
pub use removal::remove_reviewed_files;
pub use removal::review_file_removals;
