//! Deterministic UTF-8-safe truncation for model-visible tool and command output.

pub use ash_utils_string::approx_bytes_for_tokens;
pub use ash_utils_string::approx_token_count;
pub use ash_utils_string::approx_tokens_from_byte_count;
use ash_utils_string::plan_middle_truncation;
use ash_utils_string::take_bytes_at_char_boundary;

/// Default hard byte budget for model-visible output produced by a tool.
pub const DEFAULT_TOOL_OUTPUT_MAX_BYTES: usize = 1024 * 1024;

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
        take_bytes_at_char_boundary(&formatted, maximum_bytes).to_owned()
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
        return take_bytes_at_char_boundary(&reserved_marker, maximum_bytes).to_owned();
    }

    let Some(mut plan) = plan_middle_truncation(content, maximum_bytes, &reserved_marker) else {
        return content.to_owned();
    };
    let removed = &content[plan.removed.clone()];
    plan.marker = format_truncation_marker(
        use_token_marker,
        if use_token_marker {
            approx_tokens_from_byte_count(removed.len())
        } else {
            removed.chars().count()
        },
    );
    plan.apply(content)
}

fn format_truncation_marker(use_token_marker: bool, removed_units: usize) -> String {
    if use_token_marker {
        format!("…{removed_units} tokens truncated…")
    } else {
        format!("…{removed_units} chars truncated…")
    }
}

#[cfg(test)]
#[path = "output_truncation_tests.rs"]
mod tests;
