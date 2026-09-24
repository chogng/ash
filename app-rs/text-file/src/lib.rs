//! Editor-independent lifecycle state for UTF-8 directory files.

mod lifecycle;

pub use lifecycle::{
    TextFileAccess, TextFileDiskVersion, TextFileLifecycle, TextFileModifiedAt,
    TextFileObserveResult, TextFileSaveRequest, TextFileSnapshot, TextFileStatus,
};
