use ash_protocol::ModelMoneyAmount;
use ash_protocol::ModelReferenceCostRecord;
use ash_protocol::ModelReferenceCostSummary;
use std::collections::BTreeMap;

/// Computes the next exact per-currency total; unknown costs make the result incomplete.
/// Returns `None` for malformed stored amounts or integer overflow, without changing the input.
pub fn checked_record_reference_cost(
    summary: &ModelReferenceCostSummary,
    reference_cost: &ModelReferenceCostRecord,
) -> Option<ModelReferenceCostSummary> {
    let (amount, complete) = match reference_cost {
        ModelReferenceCostRecord::Complete { cost } => (Some(&cost.amount), summary.complete),
        ModelReferenceCostRecord::Partial { known_minimum, .. } => {
            (Some(&known_minimum.amount), false)
        }
        ModelReferenceCostRecord::Unpriced { .. } => (None, false),
    };
    checked_add(summary, amount, complete)
}

fn checked_add(
    summary: &ModelReferenceCostSummary,
    amount: Option<&ModelMoneyAmount>,
    complete: bool,
) -> Option<ModelReferenceCostSummary> {
    let mut totals = BTreeMap::new();
    for known in &summary.known_amounts {
        if known.currency.trim().is_empty() {
            return None;
        }
        let pico_units = known.pico_units.parse::<u128>().ok()?;
        if totals.insert(known.currency.clone(), pico_units).is_some() {
            return None;
        }
    }
    if let Some(amount) = amount {
        if amount.currency.trim().is_empty() {
            return None;
        }
        let pico_units = amount.pico_units.parse::<u128>().ok()?;
        let total = totals.entry(amount.currency.clone()).or_insert(0u128);
        *total = total.checked_add(pico_units)?;
    }
    Some(ModelReferenceCostSummary {
        known_amounts: totals
            .into_iter()
            .map(|(currency, pico_units)| ModelMoneyAmount {
                currency,
                pico_units: pico_units.to_string(),
            })
            .collect(),
        complete,
    })
}

#[cfg(test)]
#[path = "summary_tests.rs"]
mod tests;
