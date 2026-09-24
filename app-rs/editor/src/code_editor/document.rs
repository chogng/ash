//! Owned text snapshot used by the ordinary CodeEditor projection.

use std::fmt;
use std::ops::Range;

use ash_editor_core::EditorCoreDocument;
use ash_editor_core::EditorCoreDocumentSnapshot;
use ash_editor_core::EditorCoreHistoryLimit;
pub use ash_editor_core::EditorCoreRevision as CodeEditorRevision;
use ash_editor_core::EditorCoreSelection;
use ash_editor_core::EditorCoreSelectionSet;
use ash_editor_core::EditorCoreTextEdit;
use ash_editor_core::EditorCoreTextRange;
use ash_editor_core::EditorCoreTransaction;
use ash_editor_core::EditorCoreUtf16Offset;
use zui::ui::TextInputCompositionCursor;

use super::CodeEditorComposition;
use super::CodeEditorFoldControl;
use super::CodeEditorFoldState;
use super::CodeEditorFoldingRange;
use super::CodeEditorIndentation;
use super::CodeEditorLanguage;
use super::CodeEditorPosition;
use super::CodeEditorRow;
use super::CodeEditorRowSource;
use super::CodeEditorSelection;
use super::CodeEditorSyntaxToken;
use super::analysis::CodeEditorAnalysis;
use super::auto_pairs::CodeEditorAutoPairTracker;
use super::folding::CodeEditorFoldingProjection;
use super::folding_sources::derived_folding_ranges;

const HISTORY_LIMIT: usize = 100;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct Composition {
    pub(super) text: String,
    pub(super) cursor: TextInputCompositionCursor,
}

/// Owned text snapshot projected as numbered CodeEditor rows.
pub struct CodeEditorDocument {
    pub(super) core: EditorCoreDocument,
    pub(super) text: String,
    pub(super) line_ranges: Vec<Range<usize>>,
    pub(super) anchor: usize,
    pub(super) cursor: usize,
    pub(super) preferred_column: Option<usize>,
    pub(super) composition: Option<Composition>,
    pub(super) auto_pairs: CodeEditorAutoPairTracker,
    pub(super) syntax_tokens: Vec<Vec<CodeEditorSyntaxToken>>,
    pub(super) syntax_folding_ranges: Vec<CodeEditorFoldingRange>,
    pub(super) manual_folding_ranges: Vec<CodeEditorFoldingRange>,
    pub(super) folding: CodeEditorFoldingProjection,
    pub(super) analysis: CodeEditorAnalysis,
    pub(super) indentation: CodeEditorIndentation,
}

impl Clone for CodeEditorDocument {
    fn clone(&self) -> Self {
        let mut clone = Self::from_text_with_language(&self.text, self.language());
        clone.core = self.core.clone();
        clone.anchor = self.anchor;
        clone.cursor = self.cursor;
        clone.preferred_column = self.preferred_column;
        clone.composition = self.composition.clone();
        clone.syntax_folding_ranges = self.syntax_folding_ranges.clone();
        clone.manual_folding_ranges = self.manual_folding_ranges.clone();
        clone.folding = self.folding.clone();
        clone.indentation = self.indentation.clone();
        clone
    }
}

impl fmt::Debug for CodeEditorDocument {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CodeEditorDocument")
            .field("text", &self.text)
            .field("line_ranges", &self.line_ranges)
            .field("anchor", &self.anchor)
            .field("cursor", &self.cursor)
            .field("preferred_column", &self.preferred_column)
            .field("composition", &self.composition)
            .field("syntax_tokens", &self.syntax_tokens)
            .field("syntax_folding_ranges", &self.syntax_folding_ranges)
            .field("manual_folding_ranges", &self.manual_folding_ranges)
            .field("folding", &self.folding)
            .field("language", &self.language())
            .field("indentation", &self.indentation)
            .field("revision", &self.core.revision())
            .finish()
    }
}

impl PartialEq for CodeEditorDocument {
    fn eq(&self, other: &Self) -> bool {
        self.text == other.text
            && self.line_ranges == other.line_ranges
            && self.anchor == other.anchor
            && self.cursor == other.cursor
            && self.preferred_column == other.preferred_column
            && self.composition == other.composition
            && self.syntax_tokens == other.syntax_tokens
            && self.syntax_folding_ranges == other.syntax_folding_ranges
            && self.manual_folding_ranges == other.manual_folding_ranges
            && self.folding == other.folding
            && self.language() == other.language()
            && self.indentation == other.indentation
            && self.core == other.core
    }
}

impl Eq for CodeEditorDocument {}

impl Default for CodeEditorDocument {
    fn default() -> Self {
        Self::from_text("")
    }
}

impl CodeEditorDocument {
    pub fn from_text(text: impl Into<String>) -> Self {
        Self::from_text_with_language(text, CodeEditorLanguage::PlainText)
    }

    pub fn from_text_with_language(text: impl Into<String>, language: CodeEditorLanguage) -> Self {
        let text = text.into();
        let mut document = Self {
            core: EditorCoreDocument::with_history_limit(
                text.clone(),
                EditorCoreHistoryLimit::new(HISTORY_LIMIT),
            ),
            text,
            line_ranges: Vec::new(),
            anchor: 0,
            cursor: 0,
            preferred_column: None,
            composition: None,
            auto_pairs: CodeEditorAutoPairTracker::default(),
            syntax_tokens: Vec::new(),
            syntax_folding_ranges: Vec::new(),
            manual_folding_ranges: Vec::new(),
            folding: CodeEditorFoldingProjection::default(),
            analysis: CodeEditorAnalysis::default(),
            indentation: CodeEditorIndentation::default(),
        };
        document.analysis.set_language(language);
        document.reindex_lines();
        document.refresh_syntax();
        document
    }

    pub fn replace_text(&mut self, text: impl Into<String>) {
        self.text = text.into();
        self.anchor = 0;
        self.cursor = 0;
        self.preferred_column = None;
        self.composition = None;
        self.auto_pairs.clear();
        self.manual_folding_ranges.clear();
        self.folding.clear_state(0);
        self.reindex_lines();
        self.refresh_syntax();
        let selections = EditorCoreSelectionSet::single(EditorCoreSelection::collapsed_at(
            EditorCoreUtf16Offset::ZERO,
        ));
        self.core
            .replace_text(self.text.clone(), selections)
            .expect("a Native document reset always supplies a valid collapsed selection");
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn anchor(&self) -> usize {
        self.anchor
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    pub const fn revision(&self) -> CodeEditorRevision {
        self.core.revision()
    }

    pub fn selected_text(&self) -> Option<&str> {
        (self.anchor != self.cursor).then(|| &self.text[self.selection_range()])
    }

    pub fn set_selection(&mut self, anchor: CodeEditorPosition, cursor: CodeEditorPosition) {
        self.cancel_composition();
        self.anchor = self.offset_for_position(anchor);
        self.cursor = self.offset_for_position(cursor);
        self.preferred_column = None;
    }

    /// Moves or extends the committed selection to a projected editor position.
    pub fn move_to(&mut self, position: CodeEditorPosition, mode: super::CodeEditorSelectionMode) {
        self.cancel_composition();
        self.cursor = self.offset_for_position(position);
        if mode == super::CodeEditorSelectionMode::Move {
            self.anchor = self.cursor;
        }
        self.preferred_column = None;
    }

    pub const fn language(&self) -> CodeEditorLanguage {
        self.analysis.language()
    }

    pub fn set_language(&mut self, language: CodeEditorLanguage) {
        self.auto_pairs.clear();
        self.analysis.set_language(language);
        self.refresh_syntax();
    }

    /// Returns every folding candidate available for the current text snapshot.
    pub fn folding_ranges(&self) -> &[CodeEditorFoldingRange] {
        self.folding.ranges()
    }

    /// Registers one explicit user-owned folding range for the current text snapshot.
    ///
    /// Manual ranges are intentionally transient: any text mutation clears them rather than
    /// guessing how a source-row range should move through an arbitrary edit.
    pub fn add_manual_folding_range(&mut self, range: CodeEditorFoldingRange) -> bool {
        if range.end_row() >= self.line_ranges.len()
            || self.manual_folding_ranges.binary_search(&range).is_ok()
        {
            return false;
        }
        self.manual_folding_ranges.push(range);
        self.manual_folding_ranges.sort_unstable();
        self.synchronize_folding();
        true
    }

    /// Removes one explicit user-owned folding range from the current text snapshot.
    pub fn remove_manual_folding_range(&mut self, range: CodeEditorFoldingRange) -> bool {
        let Ok(index) = self.manual_folding_ranges.binary_search(&range) else {
            return false;
        };
        self.manual_folding_ranges.remove(index);
        self.synchronize_folding();
        true
    }

    /// Toggles an explicit folding range spanning the current multi-row selection.
    ///
    /// A collapsed or same-row selection does nothing. This command-facing method gives hosts a
    /// manual-fold action without requiring them to reproduce source-row selection semantics.
    pub(super) fn toggle_manual_folding_selection(&mut self) -> bool {
        let selection = self.selection_range();
        if selection.is_empty() {
            return false;
        }
        let start_row = self.row_index_for_offset(selection.start);
        let end_row = self.row_index_for_offset(selection.end.saturating_sub(1));
        let Some(range) = CodeEditorFoldingRange::new(start_row, end_row) else {
            return false;
        };
        if self.remove_manual_folding_range(range) {
            return true;
        }
        self.add_manual_folding_range(range)
    }

    /// Returns the current state for a fold starting at `source_row`.
    pub fn fold_state(&self, source_row: usize) -> Option<CodeEditorFoldState> {
        self.folding.state_at(source_row)
    }

    /// Toggles the fold starting at `source_row` and returns its resulting state.
    pub fn toggle_fold(&mut self, source_row: usize) -> Option<CodeEditorFoldState> {
        let state = self.fold_state(source_row)?;
        let next = match state {
            CodeEditorFoldState::Expanded => CodeEditorFoldState::Collapsed,
            CodeEditorFoldState::Collapsed => CodeEditorFoldState::Expanded,
        };
        self.set_fold_state(source_row, next);
        Some(next)
    }

    /// Toggles a control returned by [`super::CodeEditor::fold_control_at`].
    ///
    /// A stale control is ignored when its range no longer matches the current syntax snapshot.
    pub fn toggle_fold_control(
        &mut self,
        control: CodeEditorFoldControl,
    ) -> Option<CodeEditorFoldState> {
        let range = control.range();
        if self.folding.range_starting_at(range.start_row()) != Some(range) {
            return None;
        }
        self.toggle_fold(range.start_row())
    }

    /// Applies an explicit fold state so host call sites do not encode state as a boolean.
    pub fn set_fold_state(&mut self, source_row: usize, state: CodeEditorFoldState) {
        match state {
            CodeEditorFoldState::Expanded => {
                self.folding.expand(source_row, self.line_ranges.len());
            }
            CodeEditorFoldState::Collapsed => {
                let Some(range) = self.folding.range_starting_at(source_row) else {
                    return;
                };
                let folded_offset = self
                    .line_ranges
                    .get(source_row)
                    .map_or(self.text.len(), |line| line.end);
                if range.hides(self.row_index_for_offset(self.anchor)) {
                    self.anchor = folded_offset;
                }
                if range.hides(self.row_index_for_offset(self.cursor)) {
                    self.cursor = folded_offset;
                }
                self.folding.collapse(source_row, self.line_ranges.len());
            }
        }
    }

    pub(super) fn reindex_lines(&mut self) {
        self.line_ranges.clear();
        let bytes = self.text.as_bytes();
        let mut start = 0;
        let mut index = 0;
        while index < bytes.len() {
            match bytes[index] {
                b'\n' => {
                    let end = if index > start && bytes[index - 1] == b'\r' {
                        index - 1
                    } else {
                        index
                    };
                    self.line_ranges.push(start..end);
                    start = index + 1;
                }
                b'\r' if bytes.get(index + 1) != Some(&b'\n') => {
                    self.line_ranges.push(start..index);
                    start = index + 1;
                }
                _ => {}
            }
            index += 1;
        }
        if start <= self.text.len() {
            self.line_ranges.push(start..self.text.len());
        }
        self.cursor = self.cursor.min(self.text.len());
        self.anchor = self.anchor.min(self.text.len());
        while !self.text.is_char_boundary(self.cursor) {
            self.cursor -= 1;
        }
        while !self.text.is_char_boundary(self.anchor) {
            self.anchor -= 1;
        }
    }

    pub(super) fn synchronize_core_selection(&mut self) {
        let transaction =
            EditorCoreTransaction::new(self.core.revision(), Vec::new(), self.core_selection_set());
        self.core
            .apply_transaction(transaction)
            .expect("Native selection offsets always remain valid UTF-8 boundaries");
    }

    pub(super) fn commit_native_text_mutation(&mut self) {
        let range = EditorCoreTextRange::new(
            EditorCoreUtf16Offset::ZERO,
            EditorCoreUtf16Offset::at_byte_offset(self.core.text(), self.core.text().len())
                .expect("a string end is always a UTF-8 boundary"),
        )
        .expect("the complete document range is ordered");
        let transaction = EditorCoreTransaction::new(
            self.core.revision(),
            vec![EditorCoreTextEdit::new(range, self.text.clone())],
            self.core_selection_set(),
        );
        let snapshot = self
            .core
            .apply_transaction(transaction)
            .expect("Native mutations maintain valid text and selection boundaries");
        debug_assert_eq!(snapshot.text(), self.text);
    }

    pub(super) fn adopt_core_snapshot(&mut self, snapshot: &EditorCoreDocumentSnapshot) {
        let selection = snapshot.selections().selections()[0];
        let anchor = selection
            .anchor()
            .byte_offset_in(snapshot.text())
            .expect("core snapshots contain valid UTF-16 selection offsets");
        let cursor = selection
            .active()
            .byte_offset_in(snapshot.text())
            .expect("core snapshots contain valid UTF-16 selection offsets");
        let text_changed = self.text != snapshot.text();
        self.text = snapshot.text().to_owned();
        self.anchor = anchor;
        self.cursor = cursor;
        self.preferred_column = None;
        self.composition = None;
        if !text_changed {
            return;
        }
        self.auto_pairs.clear();
        self.manual_folding_ranges.clear();
        self.reindex_lines();
        self.refresh_syntax();
    }

    fn core_selection_set(&self) -> EditorCoreSelectionSet {
        EditorCoreSelectionSet::single(EditorCoreSelection::new(
            EditorCoreUtf16Offset::at_byte_offset(&self.text, self.anchor)
                .expect("Native selection anchors are valid UTF-8 boundaries"),
            EditorCoreUtf16Offset::at_byte_offset(&self.text, self.cursor)
                .expect("Native selection cursors are valid UTF-8 boundaries"),
        ))
    }

    pub(super) fn current_line_range(&self) -> Range<usize> {
        self.line_ranges
            .get(self.row_index_for_offset(self.cursor))
            .cloned()
            .unwrap_or(self.text.len()..self.text.len())
    }

    pub(super) fn row_index_for_offset(&self, offset: usize) -> usize {
        self.line_ranges
            .iter()
            .position(|range| offset <= range.end)
            .unwrap_or_else(|| self.line_ranges.len().saturating_sub(1))
    }

    pub(super) fn position_for_offset(&self, offset: usize) -> CodeEditorPosition {
        let row_index = self.row_index_for_offset(offset);
        let start = self
            .line_ranges
            .get(row_index)
            .map(|range| range.start)
            .unwrap_or(0);
        CodeEditorPosition {
            row_index,
            byte_offset: offset.saturating_sub(start),
        }
    }

    fn offset_for_position(&self, position: CodeEditorPosition) -> usize {
        let Some(range) = self.line_ranges.get(position.row_index) else {
            return self.text.len();
        };
        let relative = position.byte_offset.min(range.end - range.start);
        let mut offset = range.start + relative;
        while !self.text.is_char_boundary(offset) {
            offset -= 1;
        }
        offset
    }

    pub(super) fn source_row_for_visual(&self, visual_row: usize) -> Option<usize> {
        self.folding.source_row(visual_row)
    }

    pub(super) fn visual_row_for_source(&self, source_row: usize) -> Option<usize> {
        self.folding.visual_row(source_row)
    }

    pub(super) fn reveal_source_row(&mut self, source_row: usize) {
        let hidden_by = self
            .folding
            .ranges()
            .iter()
            .copied()
            .filter(|range| {
                range.hides(source_row)
                    && self.fold_state(range.start_row()) == Some(CodeEditorFoldState::Collapsed)
            })
            .map(CodeEditorFoldingRange::start_row)
            .collect::<Vec<_>>();
        for start_row in hidden_by {
            self.folding.expand(start_row, self.line_ranges.len());
        }
    }
}

impl CodeEditorRowSource for CodeEditorDocument {
    fn row_count(&self) -> usize {
        self.folding.row_count()
    }

    fn largest_line_number(&self) -> usize {
        self.line_ranges.len()
    }

    fn row(&self, index: usize) -> Option<CodeEditorRow<'_>> {
        let source_row = self.folding.source_row(index)?;
        let range = self.line_ranges.get(source_row)?.clone();
        let syntax = self
            .syntax_tokens
            .get(source_row)
            .cloned()
            .unwrap_or_default();
        Some(CodeEditorRow::new(source_row + 1, &self.text[range]).with_syntax_tokens(syntax))
    }

    fn source_byte_range(&self, source_row: usize) -> Option<Range<usize>> {
        self.line_ranges.get(source_row).cloned()
    }

    fn source_row(&self, visual_row: usize) -> Option<usize> {
        self.folding.source_row(visual_row)
    }

    fn visual_row(&self, source_row: usize) -> Option<usize> {
        self.folding.visual_row(source_row)
    }

    fn folding_range(
        &self,
        source_row: usize,
    ) -> Option<(CodeEditorFoldingRange, CodeEditorFoldState)> {
        Some((
            self.folding.range_starting_at(source_row)?,
            self.folding.state_at(source_row)?,
        ))
    }

    fn caret(&self) -> Option<CodeEditorPosition> {
        Some(self.position_for_offset(self.cursor))
    }

    fn selection(&self) -> Option<CodeEditorSelection> {
        let selection = self.selection_range();
        (selection.start != selection.end).then(|| CodeEditorSelection {
            start: self.position_for_offset(selection.start),
            end: self.position_for_offset(selection.end),
        })
    }

    fn composition(&self) -> Option<CodeEditorComposition<'_>> {
        self.composition
            .as_ref()
            .map(|composition| CodeEditorComposition {
                text: &composition.text,
                cursor: &composition.cursor,
            })
    }
}

impl CodeEditorDocument {
    pub(super) fn refresh_syntax(&mut self) {
        let snapshot = self.analysis.synchronize(&self.text, &self.line_ranges);
        self.syntax_tokens = snapshot.syntax_tokens;
        self.syntax_folding_ranges = snapshot.folding_ranges;
        self.synchronize_folding();
    }

    fn synchronize_folding(&mut self) {
        let mut ranges = self.syntax_folding_ranges.clone();
        ranges.extend(derived_folding_ranges(
            &self.text,
            &self.line_ranges,
            self.language(),
        ));
        ranges.extend(self.manual_folding_ranges.iter().copied());
        self.folding.synchronize(ranges, self.line_ranges.len());
    }

    pub(crate) fn syntax_tokens_for_row(&self, row_index: usize) -> &[CodeEditorSyntaxToken] {
        self.syntax_tokens
            .get(row_index)
            .map(Vec::as_slice)
            .unwrap_or_default()
    }
}
