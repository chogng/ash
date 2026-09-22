use serde::Deserialize;
use serde::Serialize;

use crate::EditorCoreRevision;
use crate::EditorCoreSelectionSet;
use crate::EditorCoreTextRange;

/// States whether a committed transaction starts a new undo step or joins the latest one.
///
/// Hosts choose `MergeWithPrevious` only after validating their own typing or IME grouping rules.
/// The document then retains the earliest pre-transaction snapshot for that undo step.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EditorCoreHistoryMerge {
    Separate,
    MergeWithPrevious,
}

/// One replacement against the immutable text identified by a transaction revision.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorCoreTextEdit {
    range: EditorCoreTextRange,
    text: String,
}

impl EditorCoreTextEdit {
    pub fn new(range: EditorCoreTextRange, text: impl Into<String>) -> Self {
        Self {
            range,
            text: text.into(),
        }
    }

    pub const fn range(&self) -> EditorCoreTextRange {
        self.range
    }

    pub fn text(&self) -> &str {
        &self.text
    }
}

/// One atomic multi-edit transaction with explicit post-transaction selections.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorCoreTransaction {
    base_revision: EditorCoreRevision,
    edits: Vec<EditorCoreTextEdit>,
    selections: EditorCoreSelectionSet,
}

impl EditorCoreTransaction {
    pub fn new(
        base_revision: EditorCoreRevision,
        edits: Vec<EditorCoreTextEdit>,
        selections: EditorCoreSelectionSet,
    ) -> Self {
        Self {
            base_revision,
            edits,
            selections,
        }
    }

    pub const fn base_revision(&self) -> EditorCoreRevision {
        self.base_revision
    }

    pub fn edits(&self) -> &[EditorCoreTextEdit] {
        &self.edits
    }

    pub const fn selections(&self) -> &EditorCoreSelectionSet {
        &self.selections
    }
}

/// A rejected transaction never changes the document, revision, selection, or history.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EditorCoreEditError {
    StaleRevision {
        expected: EditorCoreRevision,
        received: EditorCoreRevision,
    },
    InvalidUtf16Offset,
    InvalidUtf8Offset,
    InvalidTextRange,
    OverlappingEditRanges,
    DuplicateEditStart,
    InvalidSelection,
    Utf16OffsetOverflow,
}
