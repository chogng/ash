use super::{
    ToolOutputTruncationPolicy, approx_bytes_for_tokens, approx_token_count,
    approx_tokens_from_byte_count, formatted_truncate_text, truncate_text,
};

#[test]
fn byte_truncation_preserves_utf8_and_both_sides() {
    let content = format!("{}\nsecond line with text\n", "😀".repeat(16));

    let truncated = truncate_text(&content, ToolOutputTruncationPolicy::Bytes(48));

    assert!(truncated.len() <= 48);
    assert!(truncated.starts_with("😀"));
    assert!(truncated.contains("chars truncated"));
    assert!(truncated.ends_with("text\n"));
}

#[test]
fn formatted_truncation_is_bounded_and_reports_original_shape() {
    let content = "alpha\nbeta\n".repeat(100);

    let truncated = formatted_truncate_text(&content, ToolOutputTruncationPolicy::Bytes(256));

    assert!(truncated.len() <= 256);
    assert!(truncated.starts_with("Warning: truncated output"));
    assert!(truncated.contains("Total output lines: 200"));
    assert!(truncated.contains("chars truncated"));
}

#[test]
fn approximate_token_policy_uses_the_shared_four_byte_estimate() {
    assert_eq!(approx_token_count("12345"), 2);
    assert_eq!(approx_bytes_for_tokens(3), 12);
    assert_eq!(approx_tokens_from_byte_count(9), 3);
    assert_eq!(
        approx_tokens_from_byte_count(usize::MAX),
        usize::MAX / 4 + 1
    );

    let content = "long output ".repeat(100);
    let policy = ToolOutputTruncationPolicy::ApproximateTokens(32);
    let truncated = truncate_text(&content, policy);

    assert!(truncated.len() <= 128);
    assert!(truncated.contains("tokens truncated"));
}

#[test]
fn truncation_never_splits_a_utf8_code_point_at_tiny_budgets() {
    for maximum_bytes in 0..4 {
        let truncated = truncate_text("😀", ToolOutputTruncationPolicy::Bytes(maximum_bytes));
        assert!(truncated.len() <= maximum_bytes);
        assert!(truncated.is_char_boundary(truncated.len()));
    }
}
