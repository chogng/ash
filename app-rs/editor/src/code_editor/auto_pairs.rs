//! Ephemeral provenance for delimiters inserted automatically by the editor.

use std::ops::Range;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(super) struct CodeEditorAutoPairTracker {
    pairs: Vec<CodeEditorAutoPair>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CodeEditorAutoPair {
    opening: Range<usize>,
    closing: Range<usize>,
}

impl CodeEditorAutoPairTracker {
    pub(super) fn clear(&mut self) {
        self.pairs.clear();
    }

    pub(super) fn record(&mut self, opening: Range<usize>, closing: Range<usize>) {
        self.pairs.push(CodeEditorAutoPair { opening, closing });
    }

    pub(super) fn contains_close_at(&self, offset: usize, close: &str) -> bool {
        self.pairs.iter().any(|pair| {
            pair.opening.end == offset
                && pair.closing.start == offset
                && pair.closing.len() == close.len()
        })
    }

    pub(super) fn pair_around(&self, opening: Range<usize>, closing: Range<usize>) -> bool {
        self.pairs
            .iter()
            .any(|pair| pair.opening == opening && pair.closing == closing)
    }

    pub(super) fn remove_pair_around(&mut self, opening: Range<usize>, closing: Range<usize>) {
        self.pairs
            .retain(|pair| pair.opening != opening || pair.closing != closing);
    }

    /// Maps surviving pair ranges through one exact text replacement.
    pub(super) fn apply_text_edit(&mut self, range: Range<usize>, replacement_len: usize) {
        self.pairs.retain_mut(|pair| {
            if range.end <= pair.opening.start {
                shift_range(&mut pair.opening, range.len(), replacement_len);
                shift_range(&mut pair.closing, range.len(), replacement_len);
                return true;
            }
            if range.start >= pair.closing.end {
                return true;
            }
            if range.start >= pair.opening.end && range.end <= pair.closing.start {
                shift_range(&mut pair.closing, range.len(), replacement_len);
                return true;
            }
            false
        });
    }
}

fn shift_range(range: &mut Range<usize>, removed_len: usize, inserted_len: usize) {
    range.start = shift_offset(range.start, removed_len, inserted_len);
    range.end = shift_offset(range.end, removed_len, inserted_len);
}

fn shift_offset(offset: usize, removed_len: usize, inserted_len: usize) -> usize {
    if inserted_len >= removed_len {
        offset.saturating_add(inserted_len - removed_len)
    } else {
        offset.saturating_sub(removed_len - inserted_len)
    }
}
