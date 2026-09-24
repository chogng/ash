//! Platform-neutral document transactions for editor presentation hosts.
//!
//! The crate deliberately owns no DOM, `zui`, renderer, syntax parser, file, or IPC transport.
//! Browser and Native adapters retain their own input and presentation state while synchronizing
//! through revision-bound document snapshots and transactions.

mod document;
mod transaction;
mod types;

pub use document::EditorCoreDocument;
pub use document::EditorCoreHistoryLimit;
pub use transaction::EditorCoreEditError;
pub use transaction::EditorCoreHistoryMerge;
pub use transaction::EditorCoreTextEdit;
pub use transaction::EditorCoreTransaction;
pub use types::EditorCoreDocumentSnapshot;
pub use types::EditorCoreRevision;
pub use types::EditorCoreSelection;
pub use types::EditorCoreSelectionSet;
pub use types::EditorCoreTextRange;
pub use types::EditorCoreUtf16Offset;
