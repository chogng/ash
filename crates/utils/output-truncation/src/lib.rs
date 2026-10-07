//! Deterministic UTF-8-safe truncation for model-visible tool and command output.

/// Default hard byte budget for model-visible output produced by a tool.
pub const DEFAULT_TOOL_OUTPUT_MAX_BYTES: usize = 1024 * 1024;

const APPROX_BYTES_PER_TOKEN: usize = 4;

/// Selects the deterministic budget used when output is made model-visible.
///
/// Token budgets intentionally use an approximation. Exact provider token measurement belongs to
/// the context and model-provider layers; this utility provides a bounded, source-neutral rule.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolOutputTruncationPolicy {
    Bytes(usize),
    ApproximateTokens(usize),
}

impl ToolOutputTruncationPolicy {
    /// Returns the byte budget used by this policy.
    pub const fn byte_budget(self) -> usize {
        match self {
            Self::Bytes(bytes) => bytes,
            Self::ApproximateTokens(tokens) => approx_bytes_for_tokens(tokens),
        }
    }

    const fn uses_token_marker(self) -> bool {
        matches!(self, Self::ApproximateTokens(_))
    }
}

/// Estimates tokens for a bounded truncation decision using four UTF-8 bytes per token.
pub const fn approx_token_count(text: &str) -> usize {
    approx_tokens_from_byte_count(text.len())
}

/// Converts an approximate token budget into its byte budget.
pub const fn approx_bytes_for_tokens(tokens: usize) -> usize {
    tokens.saturating_mul(APPROX_BYTES_PER_TOKEN)
}

/// Estimates tokens from a byte count using the shared four-bytes-per-token rule.
pub const fn approx_tokens_from_byte_count(bytes: usize) -> usize {
    bytes.div_ceil(APPROX_BYTES_PER_TOKEN)
}

/// Adds a model-visible warning to text that was truncated from the middle.
pub fn formatted_truncate_text(content: &str, policy: ToolOutputTruncationPolicy) -> String {
    let maximum_bytes = policy.byte_budget();
    if content.len() <= maximum_bytes {
        return content.to_owned();
    }
    if maximum_bytes == 0 {
        return String::new();
    }

    let header = format!(
        "Warning: truncated output (original token count: {})\nTotal output lines: {}\n\n",
        approx_token_count(content),
        content.lines().count()
    );
    let body_budget = maximum_bytes.saturating_sub(header.len());
    let body = truncate_middle(content, body_budget, policy.uses_token_marker());
    let mut formatted = String::with_capacity(header.len() + body.len());
    formatted.push_str(&header);
    formatted.push_str(&body);

    if formatted.len() <= maximum_bytes {
        formatted
    } else {
        truncate_to_bytes(&formatted, maximum_bytes)
    }
}

/// Truncates the middle of text while preserving UTF-8 boundaries and both ends.
pub fn truncate_text(content: &str, policy: ToolOutputTruncationPolicy) -> String {
    truncate_middle(content, policy.byte_budget(), policy.uses_token_marker())
}

fn truncate_middle(content: &str, maximum_bytes: usize, use_token_marker: bool) -> String {
    if content.is_empty() {
        return String::new();
    }
    if content.len() <= maximum_bytes {
        return content.to_owned();
    }
    if maximum_bytes == 0 {
        return String::new();
    }

    let maximum_units = if use_token_marker {
        approx_tokens_from_byte_count(content.len())
    } else {
        content.chars().count()
    };
    let reserved_marker = format_truncation_marker(use_token_marker, maximum_units);
    if reserved_marker.len() >= maximum_bytes {
        return truncate_to_bytes(&reserved_marker, maximum_bytes);
    }

    let content_budget = maximum_bytes - reserved_marker.len();
    let (removed_chars, prefix, suffix) = split_string(
        content,
        content_budget / 2,
        content_budget - content_budget / 2,
    );
    let removed_bytes = content
        .len()
        .saturating_sub(prefix.len())
        .saturating_sub(suffix.len());
    let marker = format_truncation_marker(
        use_token_marker,
        if use_token_marker {
            approx_tokens_from_byte_count(removed_bytes)
        } else {
            removed_chars
        },
    );

    let mut output = String::with_capacity(prefix.len() + marker.len() + suffix.len());
    output.push_str(prefix);
    output.push_str(&marker);
    output.push_str(suffix);
    truncate_to_bytes(&output, maximum_bytes)
}

fn split_string(content: &str, beginning_bytes: usize, ending_bytes: usize) -> (usize, &str, &str) {
    let length = content.len();
    let tail_start_target = length.saturating_sub(ending_bytes);
    let mut prefix_end = 0usize;
    let mut suffix_start = length;
    let mut removed_chars = 0usize;
    let mut suffix_started = false;

    for (index, character) in content.char_indices() {
        let character_end = index + character.len_utf8();
        if character_end <= beginning_bytes {
            prefix_end = character_end;
            continue;
        }

        if index >= tail_start_target {
            if !suffix_started {
                suffix_start = index;
                suffix_started = true;
            }
            continue;
        }

        removed_chars = removed_chars.saturating_add(1);
    }

    if suffix_start < prefix_end {
        suffix_start = prefix_end;
    }

    (
        removed_chars,
        &content[..prefix_end],
        &content[suffix_start..],
    )
}

fn format_truncation_marker(use_token_marker: bool, removed_units: usize) -> String {
    if use_token_marker {
        format!("…{removed_units} tokens truncated…")
    } else {
        format!("…{removed_units} chars truncated…")
    }
}

fn truncate_to_bytes(value: &str, maximum_bytes: usize) -> String {
    let boundary = value
        .char_indices()
        .take_while(|(index, character)| *index + character.len_utf8() <= maximum_bytes)
        .map(|(index, character)| index + character.len_utf8())
        .last()
        .unwrap_or(0);
    value[..boundary].to_owned()
}

#[cfg(test)]
#[path = "output_truncation_tests.rs"]
mod tests;
