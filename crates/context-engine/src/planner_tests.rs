use super::ContextBudgetDecision;
use super::ContextBudgetPlanner;
use crate::ContextBudget;
use crate::ContextCompactionLimit;
use crate::ContextTokenCount;
use crate::ContextTokenMeasurement;
use crate::ContextTokenMeasurementSource;

#[test]
fn exact_count_below_pressure_fits() {
    let assessment = ContextBudgetPlanner::assess(
        budget(),
        ContextTokenMeasurement::exact(
            ContextTokenCount::new(69_000),
            ContextTokenMeasurementSource::local_tokenizer("model-tokenizer-v3").unwrap(),
        ),
    )
    .unwrap();

    assert!(matches!(
        assessment.decision(),
        ContextBudgetDecision::Fits {
            remaining_before_pressure,
            ..
        } if *remaining_before_pressure == ContextTokenCount::new(1_000)
    ));
}

#[test]
fn input_between_pressure_and_hard_limit_requests_compaction() {
    let assessment = ContextBudgetPlanner::assess(
        budget(),
        ContextTokenMeasurement::exact(
            ContextTokenCount::new(75_000),
            ContextTokenMeasurementSource::provider_preflight("provider-count-v1").unwrap(),
        ),
    )
    .unwrap();

    assert!(matches!(
        assessment.decision(),
        ContextBudgetDecision::NeedsCompaction {
            overage,
            hard_limit,
            ..
        } if *overage == ContextTokenCount::new(5_000)
            && *hard_limit == ContextTokenCount::new(90_000)
    ));
}

#[test]
fn input_above_hard_limit_is_an_explicit_overflow() {
    let assessment = ContextBudgetPlanner::assess(
        budget(),
        ContextTokenMeasurement::exact(
            ContextTokenCount::new(90_001),
            ContextTokenMeasurementSource::provider_preflight("provider-count-v1").unwrap(),
        ),
    )
    .unwrap();

    assert!(matches!(
        assessment.decision(),
        ContextBudgetDecision::ExceedsContextWindow { overage, .. }
            if *overage == ContextTokenCount::new(1)
    ));
}

#[test]
fn conservative_accounted_input_drives_the_decision() {
    let measurement = ContextTokenMeasurement::estimated(
        ContextTokenCount::new(68_000),
        ContextTokenCount::new(71_000),
        ContextTokenMeasurementSource::heuristic("deterministic-bytes-v1").unwrap(),
    )
    .unwrap();
    let assessment = ContextBudgetPlanner::assess(budget(), measurement).unwrap();

    assert!(matches!(
        assessment.decision(),
        ContextBudgetDecision::NeedsCompaction {
            accounted_input,
            ..
        } if *accounted_input == ContextTokenCount::new(71_000)
    ));
}

#[test]
fn provider_managed_never_claims_that_the_request_fits() {
    let assessment = ContextBudgetPlanner::assess(
        ContextBudget::provider_managed(),
        ContextTokenMeasurement::exact(
            ContextTokenCount::new(1),
            ContextTokenMeasurementSource::provider_preflight("provider-count-v1").unwrap(),
        ),
    )
    .unwrap();

    assert_eq!(
        assessment.decision(),
        &ContextBudgetDecision::ProviderManaged
    );
}

fn budget() -> ContextBudget {
    ContextBudget::core_managed(
        ContextTokenCount::new(100_000),
        ContextTokenCount::new(8_000),
        ContextTokenCount::new(2_000),
        ContextCompactionLimit::Tokens(ContextTokenCount::new(80_000)),
    )
}
