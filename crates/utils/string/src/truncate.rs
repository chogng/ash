use crate::take_bytes_at_char_boundary;
use std::ops::Range;

const APPROX_BYTES_PER_TOKEN: usize = 4;

/// A single edit of a source string; retained byte ranges keep their original coordinates.
/// Apply this only to the source used to construct the plan. Callers with annotated content can
/// use `removed` directly and assign their own provenance to `marker`.
pub struct TextTruncation {
    pub removed: Range<usize>,
    pub marker: String,
}

impl TextTruncation {
    /// Applies the edit to its original source, preserving both retained slices verbatim.
    pub fn apply(&self, source: &str) -> String {
        let mut output = String::with_capacity(
            self.removed.start + self.marker.len() + source.len() - self.removed.end,
        );
        output.push_str(&source[..self.removed.start]);
        output.push_str(&self.marker);
        output.push_str(&source[self.removed.end..]);
        output
    }
}

/// Plans a UTF-8-safe middle deletion whose complete output fits `max_bytes`, including `marker`.
/// Returns `None` when the source fits. If the marker cannot fit, keeps the longest source prefix
/// within the budget and omits the marker. This is a byte budget, not a grapheme or token budget.
pub fn plan_middle_truncation(
    source: &str,
    max_bytes: usize,
    marker: &str,
) -> Option<TextTruncation> {
    if source.len() <= max_bytes {
        return None;
    }
    let Some(content_budget) = max_bytes.checked_sub(marker.len()) else {
        return Some(TextTruncation {
            removed: take_bytes_at_char_boundary(source, max_bytes).len()..source.len(),
            marker: String::new(),
        });
    };
    let left = content_budget / 2;
    Some(TextTruncation {
        removed: source.floor_char_boundary(left)
            ..source.ceil_char_boundary(source.len() - (content_budget - left)),
        marker: marker.to_owned(),
    })
}

/// Retains both ends of UTF-8 text under a hard byte limit that includes the marker.
pub fn truncate_middle_with_marker(source: &str, max_bytes: usize, marker: &str) -> String {
    match plan_middle_truncation(source, max_bytes, marker) {
        Some(plan) => plan.apply(source),
        None => source.to_owned(),
    }
}

/// Estimates tokens using four UTF-8 bytes per token, rounded up; this is not a tokenizer.
pub const fn approx_token_count(text: &str) -> usize {
    approx_tokens_from_byte_count(text.len())
}

/// Converts an approximate token budget to bytes, saturating on overflow.
pub const fn approx_bytes_for_tokens(tokens: usize) -> usize {
    tokens.saturating_mul(APPROX_BYTES_PER_TOKEN)
}

/// Estimates tokens from bytes without overflowing the ceiling division.
pub const fn approx_tokens_from_byte_count(bytes: usize) -> usize {
    bytes.div_ceil(APPROX_BYTES_PER_TOKEN)
}

#[cfg(test)]
#[path = "truncate_tests.rs"]
mod tests;
