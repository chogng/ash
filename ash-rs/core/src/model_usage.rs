use ash_protocol::ModelUsage;
use ash_protocol::ModelUsageSummary;
use ash_protocol::ModelUsageTotal;

// Compute both next totals before the reducer commits either state, so overflow
// cannot leave Thread and Turn usage out of sync.
pub(super) fn checked_record_usage(
    summary: &ModelUsageSummary,
    usage: Option<&ModelUsage>,
) -> Option<ModelUsageSummary> {
    Some(ModelUsageSummary {
        model_invocations: summary.model_invocations.checked_add(1)?,
        input_tokens: checked_total(
            &summary.input_tokens,
            usage.and_then(|usage| usage.input_tokens),
        )?,
        output_tokens: checked_total(
            &summary.output_tokens,
            usage.and_then(|usage| usage.output_tokens),
        )?,
        cached_input_tokens: checked_total(
            &summary.cached_input_tokens,
            usage.and_then(|usage| usage.cached_input_tokens),
        )?,
        cache_write_input_tokens: checked_total(
            &summary.cache_write_input_tokens,
            usage.and_then(|usage| usage.cache_write_input_tokens),
        )?,
        reasoning_tokens: checked_total(
            &summary.reasoning_tokens,
            usage.and_then(|usage| usage.reasoning_tokens),
        )?,
    })
}

fn checked_total(total: &ModelUsageTotal, value: Option<u64>) -> Option<ModelUsageTotal> {
    Some(ModelUsageTotal {
        reported: total.reported.checked_add(value.unwrap_or_default())?,
        complete: total.complete && value.is_some(),
    })
}

#[cfg(test)]
#[path = "model_usage_tests.rs"]
mod tests;
