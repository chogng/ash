use super::ContextMeasurementDisposition;
use super::ContextMeasurementPolicy;
use crate::ContextBudget;
use crate::ContextCompactionLimit;
use crate::ContextTokenCount;
use ash_context_engine::ContextTokenMeasurement;
use ash_context_engine::ContextTokenMeasurementCapability;
use ash_context_engine::ContextTokenMeasurementSource;
use ash_context_engine::ResolvedContextBudget;

#[test]
fn local_measurement_always_runs_and_remote_measurement_waits_for_pressure() {
    let policy = ContextMeasurementPolicy::default();

    assert!(
        policy
            .should_measure(
                budget(),
                ContextTokenCount::new(1_000),
                ContextTokenMeasurementCapability::Local,
            )
            .unwrap()
    );
    assert!(
        !policy
            .should_measure(
                budget(),
                ContextTokenCount::new(30_000),
                ContextTokenMeasurementCapability::Remote,
            )
            .unwrap()
    );
    assert!(
        policy
            .should_measure(
                budget(),
                ContextTokenCount::new(64_000),
                ContextTokenMeasurementCapability::Remote,
            )
            .unwrap()
    );
}

#[test]
fn compaction_forces_remote_measurement() {
    let mut policy = ContextMeasurementPolicy::default();
    policy.note_compaction();

    assert!(
        policy
            .should_measure(
                budget(),
                ContextTokenCount::new(1_000),
                ContextTokenMeasurementCapability::Remote,
            )
            .unwrap()
    );
}

#[test]
fn measured_estimator_error_tightens_the_next_plan() {
    let mut policy = ContextMeasurementPolicy::default();
    let source = ContextTokenMeasurementSource::provider_preflight("test-count-v1").unwrap();
    let measurement = ContextTokenMeasurement::exact(ContextTokenCount::new(72_000), source);

    assert_eq!(
        policy
            .assess(budget(), ContextTokenCount::new(69_000), measurement)
            .unwrap(),
        ContextMeasurementDisposition::Replan
    );
    let ResolvedContextBudget::CoreManaged(limits) =
        policy.adjusted_budget(budget()).resolve().unwrap()
    else {
        panic!("expected a Core-managed budget");
    };
    assert_eq!(limits.maximum_input(), ContextTokenCount::new(67_000));
    assert_eq!(limits.hard_maximum_input(), ContextTokenCount::new(87_000));
}

fn budget() -> ContextBudget {
    ContextBudget::core_managed(
        ContextTokenCount::new(100_000),
        ContextTokenCount::new(8_000),
        ContextTokenCount::new(2_000),
        ContextCompactionLimit::Tokens(ContextTokenCount::new(80_000)),
    )
}
