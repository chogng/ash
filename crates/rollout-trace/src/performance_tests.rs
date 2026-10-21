use super::*;
use serde_json::json;

fn record() -> ModelInvocationRecord {
    serde_json::from_value(json!({
        "invocationId":"call", "threadId":"root", "turnId":"turn",
        "startedAtUnixMs":10, "completedAtUnixMs":0, "outcome":"completed",
        "timing":{"totalUs":2_500_000,"firstTextUs":500_000,"textDeltaCount":3,"toolCallCount":0},
        "usage":{"outputTokens":150,"reasoningTokens":50},
        "referenceCost":{"type":"unpriced","reason":{"type":"subscriptionPlan"}}
    }))
    .unwrap()
}

fn metrics(record: &ModelInvocationRecord) -> InvocationPerformance {
    project(
        &ThreadId::new("root").unwrap(),
        &TurnId::new("turn").unwrap(),
        &EventId("event".into()),
        record,
    )
}

#[test]
fn derives_client_intervals_and_rate_without_wall_clock_arithmetic() {
    let projected = metrics(&record());
    assert_eq!(
        projected.total,
        PerformanceDuration::Measured {
            microseconds: "2500000".into()
        }
    );
    assert_eq!(
        projected.first_text,
        PerformanceDuration::Measured {
            microseconds: "500000".into()
        }
    );
    assert_eq!(
        projected.generation,
        PerformanceDuration::Measured {
            microseconds: "2000000".into()
        }
    );
    assert_eq!(
        projected.text_tps,
        PerformanceRate::Estimated {
            tokens_per_second: "50.0".into()
        }
    );
}

#[test]
fn unknown_conditions_have_explicit_stable_reasons() {
    use PerformanceUnknownReason::*;
    for (patch, expected) in [
        (json!({"timing":null}), MissingTiming),
        (
            json!({"timing":{"totalUs":10,"textDeltaCount":0,"toolCallCount":0}}),
            NoTextDeltas,
        ),
        (
            json!({"timing":{"totalUs":10,"firstTextUs":11,"textDeltaCount":2,"toolCallCount":0}}),
            InconsistentTiming,
        ),
        (
            json!({"timing":{"totalUs":10,"textDeltaCount":2,"toolCallCount":0}}),
            InconsistentTiming,
        ),
        (json!({"outcome":"failed"}), RequestNotCompleted),
        (json!({"outcome":"cancelled"}), RequestNotCompleted),
        (
            json!({"timing":{"totalUs":10,"firstTextUs":1,"textDeltaCount":1,"toolCallCount":0}}),
            SingleTextDelta,
        ),
        (
            json!({"timing":{"totalUs":10,"firstTextUs":1,"textDeltaCount":2,"toolCallCount":1}}),
            ToolOutput,
        ),
        (
            json!({"timing":{"totalUs":10,"firstTextUs":10,"textDeltaCount":2,"toolCallCount":0}}),
            ZeroGenerationDuration,
        ),
        (json!({"usage":null}), MissingUsage),
        (json!({"usage":{"reasoningTokens":0}}), MissingOutputTokens),
        (
            json!({"usage":{"outputTokens":150}}),
            MissingReasoningTokens,
        ),
        (
            json!({"usage":{"outputTokens":50,"reasoningTokens":150}}),
            InconsistentTokenUsage,
        ),
        (
            json!({"usage":{"outputTokens":50,"reasoningTokens":50}}),
            NoTextOutputTokens,
        ),
    ] {
        let mut value = serde_json::to_value(record()).unwrap();
        for (name, field) in patch.as_object().unwrap() {
            value[name] = field.clone();
        }
        let projected = metrics(&serde_json::from_value(value).unwrap());
        assert_eq!(
            projected.text_tps,
            PerformanceRate::Unknown { reason: expected }
        );
    }
}

#[test]
fn rounding_and_large_counters_are_lossless_and_old_zero_is_not_unknown() {
    let mut record = record();
    record.timing.as_mut().unwrap().first_text_us = Some(0);
    record.timing.as_mut().unwrap().total_us = 1;
    record.usage.as_mut().unwrap().output_tokens = Some(u64::MAX);
    record.usage.as_mut().unwrap().reasoning_tokens = Some(0);
    assert_eq!(
        metrics(&record).text_tps,
        PerformanceRate::Estimated {
            tokens_per_second: "18446744073709551615000000.0".into()
        }
    );
    assert_eq!(
        metrics(&record).first_text,
        PerformanceDuration::Measured {
            microseconds: "0".into()
        }
    );
    record.usage.as_mut().unwrap().output_tokens = Some(1);
    record.timing.as_mut().unwrap().total_us = 160_000;
    assert_eq!(
        metrics(&record).text_tps,
        PerformanceRate::Estimated {
            tokens_per_second: "6.3".into()
        }
    );
    record.timing.as_mut().unwrap().total_us = u64::MAX;
    assert_eq!(
        metrics(&record).total,
        PerformanceDuration::Measured {
            microseconds: u64::MAX.to_string()
        }
    );
}
