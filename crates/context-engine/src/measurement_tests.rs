use super::ContextTokenMeasurement;
use super::ContextTokenMeasurementAccuracy;
use super::ContextTokenMeasurementError;
use super::ContextTokenMeasurementSource;
use super::ContextTokenMeasurementSourceKind;
use crate::ContextTokenCount;

#[test]
fn exact_measurements_account_the_exact_count() {
    let source =
        ContextTokenMeasurementSource::provider_preflight("openai-input-tokens-v1").unwrap();
    let measurement = ContextTokenMeasurement::exact(ContextTokenCount::new(4_321), source);

    assert_eq!(measurement.measured_input(), ContextTokenCount::new(4_321));
    assert_eq!(measurement.accounted_input(), ContextTokenCount::new(4_321));
    assert_eq!(
        measurement.accuracy(),
        ContextTokenMeasurementAccuracy::Exact
    );
    assert_eq!(
        measurement.source().kind(),
        ContextTokenMeasurementSourceKind::ProviderPreflight
    );
}

#[test]
fn estimates_account_the_conservative_policy_value() {
    let source = ContextTokenMeasurementSource::heuristic("deterministic-bytes-v1").unwrap();
    let measurement = ContextTokenMeasurement::estimated(
        ContextTokenCount::new(4_000),
        ContextTokenCount::new(4_600),
        source,
    )
    .unwrap();

    assert_eq!(measurement.measured_input(), ContextTokenCount::new(4_000));
    assert_eq!(measurement.accounted_input(), ContextTokenCount::new(4_600));
    assert_eq!(
        measurement.accuracy(),
        ContextTokenMeasurementAccuracy::Estimated
    );
}

#[test]
fn source_and_accuracy_are_independent() {
    let source =
        ContextTokenMeasurementSource::provider_preflight("anthropic-count-tokens-v1").unwrap();
    let measurement = ContextTokenMeasurement::estimated(
        ContextTokenCount::new(4_000),
        ContextTokenCount::new(4_040),
        source,
    )
    .unwrap();

    assert_eq!(
        measurement.source().kind(),
        ContextTokenMeasurementSourceKind::ProviderPreflight
    );
    assert_eq!(
        measurement.accuracy(),
        ContextTokenMeasurementAccuracy::Estimated
    );
}

#[test]
fn rejects_unidentified_sources_or_optimistic_estimates() {
    assert_eq!(
        ContextTokenMeasurementSource::local_tokenizer(" ").unwrap_err(),
        ContextTokenMeasurementError::MissingSourceRevision
    );
    let source = ContextTokenMeasurementSource::heuristic("test-v1").unwrap();
    assert_eq!(
        ContextTokenMeasurement::estimated(
            ContextTokenCount::new(4_000),
            ContextTokenCount::new(3_999),
            source,
        )
        .unwrap_err(),
        ContextTokenMeasurementError::AccountedInputBelowMeasurement
    );
}
