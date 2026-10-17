use super::approx_bytes_for_tokens;
use super::approx_token_count;
use super::approx_tokens_from_byte_count;
use super::plan_middle_truncation;
use super::truncate_middle_with_marker;

#[test]
fn truncation_plan_preserves_original_slice_coordinates() {
    let source = "head🦀🦀tail";
    let plan = plan_middle_truncation(source, 13, "...").unwrap();
    assert_eq!(plan.removed, 4..12);
    assert_eq!(&source[plan.removed.clone()], "🦀🦀");
    assert_eq!(plan.apply(source), "head...tail");
    assert_eq!(
        truncate_middle_with_marker(source, 13, "..."),
        "head...tail"
    );
}

#[test]
fn truncation_obeys_total_byte_budget_even_when_the_marker_does_not_fit() {
    assert_eq!(truncate_middle_with_marker("🦀abc", 4, "notice"), "🦀");
    assert_eq!(truncate_middle_with_marker("abc", 0, "..."), "");
    assert_eq!(truncate_middle_with_marker("short", 5, "notice"), "short");
    assert!(plan_middle_truncation("", 0, "...").is_none());
    for marker in ["", "...", "…omitted…"] {
        for budget in 0..32 {
            let result = truncate_middle_with_marker("head中😀🦀tail", budget, marker);
            assert!(result.len() <= budget);
        }
    }
}

#[test]
fn approximate_tokens_round_up_without_overflow() {
    assert_eq!(approx_token_count("aé中😀"), 3);
    assert_eq!(approx_token_count(""), 0);
    assert_eq!(approx_bytes_for_tokens(3), 12);
    assert_eq!(approx_bytes_for_tokens(usize::MAX), usize::MAX);
    assert_eq!(
        approx_tokens_from_byte_count(usize::MAX),
        usize::MAX / 4 + 1
    );
}
