use super::CONTEXT_CALIBRATION_REVISION;
use super::calibrated_budget;
use super::next_context_calibrations;
use crate::context::ContextBudget;
use crate::context::ContextCompactionLimit;
use crate::context::ContextTokenCount;
use ash_context_engine::ResolvedContextBudget;
use ash_protocol::ModelId;
use ash_protocol::ModelInputEstimate;
use ash_protocol::ModelRef;
use ash_protocol::ModelUsage;
use ash_protocol::ProviderId;

#[test]
fn calibration_rises_immediately_and_decays_after_overestimation() {
    let model = model_ref("model-a");
    let estimate = estimate("deterministic-bytes-v1", 100);
    let first = next_context_calibrations(&[], &model, &estimate, Some(&usage(120))).unwrap();
    assert_eq!(first[0].correction_ratio_ppm(), 1_200_000);
    assert_eq!(first[0].samples(), 1);

    let second = next_context_calibrations(&first, &model, &estimate, Some(&usage(100))).unwrap();
    assert_eq!(second[0].correction_ratio_ppm(), 1_150_000);
    assert_eq!(second[0].samples(), 2);
}

#[test]
fn calibration_isolated_by_model_and_estimator_revision() {
    let model_a = model_ref("model-a");
    let model_b = model_ref("model-b");
    let first = next_context_calibrations(
        &[],
        &model_a,
        &estimate("estimate-v1", 100),
        Some(&usage(125)),
    )
    .unwrap();
    let second = next_context_calibrations(
        &first,
        &model_b,
        &estimate("estimate-v1", 100),
        Some(&usage(150)),
    )
    .unwrap();
    let third = next_context_calibrations(
        &second,
        &model_a,
        &estimate("estimate-v2", 100),
        Some(&usage(110)),
    )
    .unwrap();

    assert_eq!(third.len(), 3);
    assert_eq!(third[0].correction_ratio_ppm(), 1_250_000);
    assert_eq!(third[1].correction_ratio_ppm(), 1_500_000);
    assert_eq!(third[2].correction_ratio_ppm(), 1_100_000);
}

#[test]
fn missing_provider_input_usage_does_not_create_calibration() {
    let usage = ModelUsage {
        input_tokens: None,
        output_tokens: Some(4),
        cached_input_tokens: Some(90),
        cache_write_input_tokens: None,
        reasoning_tokens: None,
    };
    let calibrations = next_context_calibrations(
        &[],
        &model_ref("model-a"),
        &estimate("estimate-v1", 100),
        Some(&usage),
    )
    .unwrap();

    assert!(calibrations.is_empty());
}

#[test]
fn calibrated_budget_preserves_provider_managed_and_reduces_known_capacity() {
    let model = model_ref("model-a");
    let calibrations = next_context_calibrations(
        &[],
        &model,
        &estimate("estimate-v1", 100),
        Some(&usage(120)),
    )
    .unwrap();
    let calibration = &calibrations[0];

    assert_eq!(
        calibrated_budget(ContextBudget::provider_managed(), Some(calibration)).unwrap(),
        ContextBudget::provider_managed()
    );

    let budget = ContextBudget::core_managed(
        ContextTokenCount::new(200),
        ContextTokenCount::new(20),
        ContextTokenCount::new(10),
        ContextCompactionLimit::ContextWindow,
    );
    let calibrated = calibrated_budget(budget, Some(calibration)).unwrap();
    let ResolvedContextBudget::CoreManaged(limits) = calibrated.resolve().unwrap() else {
        panic!("known budget must stay Core-managed");
    };
    assert_eq!(limits.maximum_input(), ContextTokenCount::new(141));
    assert_eq!(limits.hard_maximum_input(), ContextTokenCount::new(141));
}

fn model_ref(model: &str) -> ModelRef {
    ModelRef::new(
        ProviderId::new("provider").unwrap(),
        ModelId::new(model).unwrap(),
    )
}

fn estimate(revision: &str, estimated_input_tokens: u64) -> ModelInputEstimate {
    ModelInputEstimate {
        estimated_input_tokens,
        estimator_revision: revision.into(),
        calibration_revision: CONTEXT_CALIBRATION_REVISION.into(),
    }
}

fn usage(input_tokens: u64) -> ModelUsage {
    ModelUsage {
        input_tokens: Some(input_tokens),
        output_tokens: Some(1),
        cached_input_tokens: Some(0),
        cache_write_input_tokens: Some(0),
        reasoning_tokens: None,
    }
}
