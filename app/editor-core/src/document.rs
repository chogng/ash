use crate::EditorCoreDocumentSnapshot;
use crate::EditorCoreEditError;
use crate::EditorCoreHistoryMerge;
use crate::EditorCoreRevision;
use crate::EditorCoreSelection;
use crate::EditorCoreSelectionSet;
use crate::EditorCoreTextEdit;
use crate::EditorCoreTransaction;
use crate::EditorCoreUtf16Offset;

/// Bounded transaction history owned by one document instance.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EditorCoreHistoryLimit {
    transactions: usize,
}

impl EditorCoreHistoryLimit {
    pub const fn new(transactions: usize) -> Self {
        Self { transactions }
    }

    pub const fn transactions(self) -> usize {
        self.transactions
    }
}

impl Default for EditorCoreHistoryLimit {
    fn default() -> Self {
        Self::new(1_000)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct EditorCoreDocumentState {
    text: String,
    selections: EditorCoreSelectionSet,
}

/// Platform-neutral text document with revision-bound multi-edit transactions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditorCoreDocument {
    text: String,
    selections: EditorCoreSelectionSet,
    revision: EditorCoreRevision,
    history_limit: EditorCoreHistoryLimit,
    undo: Vec<EditorCoreDocumentState>,
    redo: Vec<EditorCoreDocumentState>,
}

impl EditorCoreDocument {
    pub fn new(text: impl Into<String>) -> Self {
        Self::with_history_limit(text, EditorCoreHistoryLimit::default())
    }

    pub fn with_history_limit(
        text: impl Into<String>,
        history_limit: EditorCoreHistoryLimit,
    ) -> Self {
        Self {
            text: text.into(),
            selections: EditorCoreSelectionSet::single(EditorCoreSelection::collapsed_at(
                EditorCoreUtf16Offset::ZERO,
            )),
            revision: EditorCoreRevision::INITIAL,
            history_limit,
            undo: Vec::new(),
            redo: Vec::new(),
        }
    }

    /// Reconstructs a document at a synchronization boundary without importing remote history.
    ///
    /// Adapters use this to validate one transaction against a local presentation snapshot before
    /// they have adopted `EditorCoreDocument` as their persistent state owner.
    pub fn from_snapshot_parts(
        text: impl Into<String>,
        revision: EditorCoreRevision,
        selections: EditorCoreSelectionSet,
    ) -> Result<Self, EditorCoreEditError> {
        let text = text.into();
        if !selections.has_valid_primary_index() {
            return Err(EditorCoreEditError::InvalidSelection);
        }
        validate_selections(&text, &selections)?;
        Ok(Self {
            text,
            selections,
            revision,
            history_limit: EditorCoreHistoryLimit::default(),
            undo: Vec::new(),
            redo: Vec::new(),
        })
    }

    pub const fn revision(&self) -> EditorCoreRevision {
        self.revision
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub const fn selections(&self) -> &EditorCoreSelectionSet {
        &self.selections
    }

    pub fn snapshot(&self) -> EditorCoreDocumentSnapshot {
        EditorCoreDocumentSnapshot::new(self.revision, self.text.clone(), self.selections.clone())
    }

    /// Replaces the complete document, clears history, and installs the supplied selections.
    ///
    /// Hosts use this for an explicit document reload rather than for ordinary editing.
    pub fn replace_text(
        &mut self,
        text: impl Into<String>,
        selections: EditorCoreSelectionSet,
    ) -> Result<EditorCoreDocumentSnapshot, EditorCoreEditError> {
        let text = text.into();
        if !selections.has_valid_primary_index() {
            return Err(EditorCoreEditError::InvalidSelection);
        }
        validate_selections(&text, &selections)?;
        self.text = text;
        self.selections = selections;
        self.undo.clear();
        self.redo.clear();
        self.revision = self.revision.next_after_committed_edit();
        Ok(self.snapshot())
    }

    /// Returns whether one previously committed text transaction can be restored.
    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    /// Returns whether one previously undone text transaction can be reapplied.
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// Applies every edit against the same base revision and then installs the supplied selections.
    pub fn apply_transaction(
        &mut self,
        transaction: EditorCoreTransaction,
    ) -> Result<EditorCoreDocumentSnapshot, EditorCoreEditError> {
        self.apply_transaction_with_history(transaction, EditorCoreHistoryMerge::Separate)
    }

    /// Applies a transaction while preserving or extending one caller-defined undo step.
    ///
    /// `MergeWithPrevious` retains the existing top undo snapshot rather than creating a new one.
    /// It is appropriate only after a presentation adapter has decided that this commit belongs to
    /// the same typing or composition group as the preceding transaction.
    pub fn apply_transaction_with_history(
        &mut self,
        transaction: EditorCoreTransaction,
        history_merge: EditorCoreHistoryMerge,
    ) -> Result<EditorCoreDocumentSnapshot, EditorCoreEditError> {
        if transaction.base_revision() != self.revision {
            return Err(EditorCoreEditError::StaleRevision {
                expected: self.revision,
                received: transaction.base_revision(),
            });
        }
        if !transaction.selections().has_valid_primary_index() {
            return Err(EditorCoreEditError::InvalidSelection);
        }
        let next_text = apply_edits(&self.text, transaction.edits())?;
        validate_selections(&next_text, transaction.selections())?;
        if next_text == self.text {
            self.selections = transaction.selections().clone();
            return Ok(self.snapshot());
        }
        self.checkpoint(history_merge);
        self.text = next_text;
        self.selections = transaction.selections().clone();
        self.revision = self.revision.next_after_committed_edit();
        Ok(self.snapshot())
    }

    /// Restores the previous committed text transaction, if one exists.
    pub fn undo(&mut self) -> Option<EditorCoreDocumentSnapshot> {
        let state = self.undo.pop()?;
        self.redo.push(self.current_state());
        self.restore(state);
        Some(self.snapshot())
    }

    /// Reapplies the next committed text transaction, if one exists.
    pub fn redo(&mut self) -> Option<EditorCoreDocumentSnapshot> {
        let state = self.redo.pop()?;
        self.undo.push(self.current_state());
        self.restore(state);
        Some(self.snapshot())
    }

    /// Clears redo entries after a host has explicitly cancelled a provisional history revision.
    pub fn discard_redo(&mut self) {
        self.redo.clear();
    }

    /// Discards the current undo checkpoint without changing text or selection.
    ///
    /// Presentation adapters use this only when a protected composition revision returns to its
    /// original text, so retaining an undo entry would create a no-op history step.
    pub fn discard_latest_undo(&mut self) {
        self.undo.pop();
    }

    fn checkpoint(&mut self, history_merge: EditorCoreHistoryMerge) {
        if history_merge == EditorCoreHistoryMerge::MergeWithPrevious && !self.undo.is_empty() {
            self.redo.clear();
            return;
        }
        if self.history_limit.transactions() == 0 {
            self.undo.clear();
        } else {
            if self.undo.len() == self.history_limit.transactions() {
                self.undo.remove(0);
            }
            self.undo.push(self.current_state());
        }
        self.redo.clear();
    }

    fn current_state(&self) -> EditorCoreDocumentState {
        EditorCoreDocumentState {
            text: self.text.clone(),
            selections: self.selections.clone(),
        }
    }

    fn restore(&mut self, state: EditorCoreDocumentState) {
        self.text = state.text;
        self.selections = state.selections;
        self.revision = self.revision.next_after_committed_edit();
    }
}

fn apply_edits(text: &str, edits: &[EditorCoreTextEdit]) -> Result<String, EditorCoreEditError> {
    let mut edits = edits
        .iter()
        .map(|edit| {
            if !edit.range().is_ordered() {
                return Err(EditorCoreEditError::InvalidTextRange);
            }
            let start = edit.range().start().byte_offset_in(text)?;
            let end = edit.range().end().byte_offset_in(text)?;
            Ok((start, end, edit.text()))
        })
        .collect::<Result<Vec<_>, EditorCoreEditError>>()?;
    edits.sort_by_key(|(start, end, _)| (*start, *end));
    for window in edits.windows(2) {
        let (previous_start, previous_end, _) = window[0];
        let (start, _, _) = window[1];
        if previous_start == start {
            return Err(EditorCoreEditError::DuplicateEditStart);
        }
        if previous_end > start {
            return Err(EditorCoreEditError::OverlappingEditRanges);
        }
    }
    let mut result = text.to_owned();
    for (start, end, replacement) in edits.into_iter().rev() {
        result.replace_range(start..end, replacement);
    }
    Ok(result)
}

fn validate_selections(
    text: &str,
    selections: &EditorCoreSelectionSet,
) -> Result<(), EditorCoreEditError> {
    for selection in selections.selections() {
        selection.anchor().byte_offset_in(text)?;
        selection.active().byte_offset_in(text)?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "document_tests.rs"]
mod tests;
