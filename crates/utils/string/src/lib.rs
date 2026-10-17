//! String operations shared across domains, without presentation or budget policy.

mod json;
mod location;
mod metric;
mod truncate;

pub use json::to_ascii_json_string;
pub use json::to_json_string_bounded;
pub use location::normalize_markdown_hash_location_suffix;
pub use metric::sanitize_metric_tag_value;
pub use truncate::TextTruncation;
pub use truncate::approx_bytes_for_tokens;
pub use truncate::approx_token_count;
pub use truncate::approx_tokens_from_byte_count;
pub use truncate::plan_middle_truncation;
pub use truncate::truncate_middle_with_marker;

/// Borrows the longest prefix whose UTF-8 byte length is at most `max_bytes`.
///
/// Returns the original slice when it fits, including when the budget exceeds its length.
/// Adds no truncation marker and never allocates. Boundaries are Unicode scalar boundaries;
/// combining marks and multi-code-point emoji can still be separated.
#[inline]
pub fn take_bytes_at_char_boundary(text: &str, max_bytes: usize) -> &str {
    &text[..text.floor_char_boundary(max_bytes)]
}

#[cfg(test)]
#[path = "string_tests.rs"]
mod tests;
