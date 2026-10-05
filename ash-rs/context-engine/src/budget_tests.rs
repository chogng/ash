use super::ContextBudget;
use super::ContextBudgetError;
use super::ContextCompactionLimit;
use super::ContextTokenCount;
use super::ResolvedContextBudget;

#[test]
fn resolves_pressure_and_hard_limits_independently() {
    let resolved = ContextBudget::core_managed(
        ContextTokenCount::new(100_000),
        ContextTokenCount::new(8_000),
        ContextTokenCount::new(2_000),
        ContextCompactionLimit::Tokens(ContextTokenCount::new(80_000)),
    )
    .resolve()
    .unwrap();

    let ResolvedContextBudget::CoreManaged(limits) = resolved else {
        panic!("expected a Core-managed budget");
    };
    assert_eq!(limits.maximum_input(), ContextTokenCount::new(70_000));
    assert_eq!(limits.hard_maximum_input(), ContextTokenCount::new(90_000));
    assert_eq!(
        limits.maximum_compaction_input(),
        ContextTokenCount::new(90_000)
    );
}

#[test]
fn context_window_pressure_uses_the_hard_limit() {
    let resolved = ContextBudget::core_managed(
        ContextTokenCount::new(20_000),
        ContextTokenCount::new(2_000),
        ContextTokenCount::new(500),
        ContextCompactionLimit::ContextWindow,
    )
    .resolve()
    .unwrap();

    let ResolvedContextBudget::CoreManaged(limits) = resolved else {
        panic!("expected a Core-managed budget");
    };
    assert_eq!(limits.maximum_input(), limits.hard_maximum_input());
}

#[test]
fn rejects_allocations_without_input_capacity() {
    let error = ContextBudget::core_managed(
        ContextTokenCount::new(100),
        ContextTokenCount::new(80),
        ContextTokenCount::new(20),
        ContextCompactionLimit::ContextWindow,
    )
    .resolve()
    .unwrap_err();

    assert_eq!(error, ContextBudgetError::NoInputCapacity);
}

#[test]
fn preserves_provider_managed_as_an_explicit_state() {
    assert_eq!(
        ContextBudget::provider_managed().resolve().unwrap(),
        ResolvedContextBudget::ProviderManaged
    );
}

#[test]
fn measured_error_reduces_pressure_and_hard_input_capacity() {
    let budget = ContextBudget::core_managed(
        ContextTokenCount::new(100_000),
        ContextTokenCount::new(8_000),
        ContextTokenCount::new(2_000),
        ContextCompactionLimit::Tokens(ContextTokenCount::new(80_000)),
    )
    .with_input_capacity_reduction(ContextTokenCount::new(5_000));

    let ResolvedContextBudget::CoreManaged(limits) = budget.resolve().unwrap() else {
        panic!("expected a Core-managed budget");
    };
    assert_eq!(limits.maximum_input(), ContextTokenCount::new(65_000));
    assert_eq!(limits.hard_maximum_input(), ContextTokenCount::new(85_000));
}

#[test]
fn provider_managed_budget_ignores_local_capacity_reduction() {
    assert_eq!(
        ContextBudget::provider_managed()
            .with_input_capacity_reduction(ContextTokenCount::new(5_000)),
        ContextBudget::ProviderManaged
    );
}

#[test]
fn checkpoint_buffer_respects_existing_pressure_and_preserves_hard_capacity() {
    let budget = ContextBudget::core_managed(
        ContextTokenCount::new(100_000),
        ContextTokenCount::new(4_000),
        ContextTokenCount::new(1_000),
        ContextCompactionLimit::Tokens(ContextTokenCount::new(90_000)),
    );
    let ResolvedContextBudget::CoreManaged(small) = budget
        .with_input_buffer(ContextTokenCount::new(8_000))
        .resolve()
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(small.maximum_input().get(), 85_000);
    let ResolvedContextBudget::CoreManaged(large) = budget
        .with_input_buffer(ContextTokenCount::new(16_000))
        .resolve()
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(large.maximum_input().get(), 79_000);
    assert_eq!(large.hard_maximum_input().get(), 95_000);
    let ResolvedContextBudget::CoreManaged(checkpoint) = budget
        .for_checkpoint(ContextTokenCount::new(8_000))
        .resolve()
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(checkpoint.maximum_input().get(), 91_000);
    assert!(
        budget
            .with_input_buffer(ContextTokenCount::new(99_000))
            .resolve()
            .is_err()
    );
}
