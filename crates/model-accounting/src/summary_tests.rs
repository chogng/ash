use super::*;
use ash_protocol::ModelReferenceCostReason;
use ash_protocol::RatedModelCost;

#[test]
fn reference_cost_summary_adds_exact_amounts_and_preserves_unknown_work() {
    let complete = ModelReferenceCostRecord::Complete {
        cost: RatedModelCost {
            amount: ModelMoneyAmount {
                currency: "USD".into(),
                pico_units: "10080000000".into(),
            },
            revision: "rates-v1".into(),
            line_items: Vec::new(),
        },
    };
    let partial = ModelReferenceCostRecord::Partial {
        known_minimum: RatedModelCost {
            amount: ModelMoneyAmount {
                currency: "USD".into(),
                pico_units: "250000000".into(),
            },
            revision: "rates-v1".into(),
            line_items: Vec::new(),
        },
        reason: ModelReferenceCostReason::MissingTokenRates {
            dimensions: vec!["cache_write_input".into()],
        },
    };

    let summary =
        checked_record_reference_cost(&ModelReferenceCostSummary::default(), &complete).unwrap();
    let summary = checked_record_reference_cost(&summary, &partial).unwrap();

    assert_eq!(
        summary,
        ModelReferenceCostSummary {
            known_amounts: vec![ModelMoneyAmount {
                currency: "USD".into(),
                pico_units: "10330000000".into(),
            }],
            complete: false,
        }
    );
}
