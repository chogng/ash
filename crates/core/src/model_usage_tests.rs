use super::*;

#[test]
fn aggregate_usage_preserves_partial_reports_and_unknown_invocations() {
    let first = ModelUsage {
        input_tokens: Some(10),
        output_tokens: Some(3),
        cached_input_tokens: Some(2),
        cache_write_input_tokens: Some(1),
        reasoning_tokens: None,
    };
    let second = ModelUsage {
        input_tokens: Some(7),
        output_tokens: None,
        cached_input_tokens: None,
        cache_write_input_tokens: None,
        reasoning_tokens: Some(1),
    };
    let summary = checked_record_usage(&ModelUsageSummary::default(), Some(&first)).unwrap();
    let summary = checked_record_usage(&summary, Some(&second)).unwrap();
    let summary = checked_record_usage(&summary, None).unwrap();

    assert_eq!(summary.model_invocations, 3);
    assert_eq!(summary.input_tokens.reported, 17);
    assert!(!summary.input_tokens.complete);
    assert_eq!(summary.output_tokens.reported, 3);
    assert!(!summary.output_tokens.complete);
    assert_eq!(summary.cached_input_tokens.reported, 2);
    assert!(!summary.cached_input_tokens.complete);
    assert_eq!(summary.cache_write_input_tokens.reported, 1);
    assert!(!summary.cache_write_input_tokens.complete);
    assert_eq!(summary.reasoning_tokens.reported, 1);
    assert!(!summary.reasoning_tokens.complete);
}
