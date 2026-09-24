use ash_editor_core::EditorCoreTransaction;

use super::CodeEditorCoreTransactionError;
use super::CodeEditorDocument;

impl CodeEditorDocument {
    /// Applies one shared document-core transaction to this single-selection Native projection.
    ///
    /// Native currently rejects multi-selection snapshots rather than silently projecting only the
    /// primary selection. IME, folding, syntax, and layout remain Native-owned around the commit.
    pub fn apply_core_transaction(
        &mut self,
        transaction: EditorCoreTransaction,
    ) -> Result<(), CodeEditorCoreTransactionError> {
        if transaction.selections().selections().len() != 1 {
            return Err(CodeEditorCoreTransactionError::MultipleSelectionsUnsupported);
        }
        self.synchronize_core_selection();
        let snapshot = self.core.apply_transaction(transaction)?;
        self.adopt_core_snapshot(&snapshot);
        Ok(())
    }
}

#[cfg(test)]
#[path = "core_transaction_tests.rs"]
mod tests;
