use super::HttpAttemptResult;
use super::HttpMethodKind;
use super::HttpStatusClassKind;
use super::MockOtelProvider;
use super::OperationOutcome;
use super::TelemetryEvent;
use ash_client::ClientOperation;
use ash_client::ClientTelemetry;
use ash_client::ClientTelemetryEvent;
use ash_client::ClientTelemetryOutcome;
use ash_http_client::HttpClientTelemetry;
use ash_http_client::HttpClientTelemetryEvent;
use ash_http_client::HttpMethod;
use ash_http_client::HttpStatusClass;
use ash_http_client::HttpTransportOutcome;
use std::num::NonZeroUsize;
use std::time::Duration;

#[test]
fn aggregates_safe_operation_and_http_facts() {
    let telemetry = MockOtelProvider::new(NonZeroUsize::new(4).unwrap());

    ClientTelemetry::start(&telemetry, ClientOperation::new("model.operation")).finish(
        ClientTelemetryEvent {
            operation: ClientOperation::new("model.operation"),
            outcome: ClientTelemetryOutcome::Succeeded,
            elapsed: Duration::from_millis(12),
        },
    );
    ClientTelemetry::start(&telemetry, ClientOperation::new("model.operation")).finish(
        ClientTelemetryEvent {
            operation: ClientOperation::new("model.operation"),
            outcome: ClientTelemetryOutcome::Failed,
            elapsed: Duration::from_millis(20),
        },
    );
    HttpClientTelemetry::start(&telemetry).finish(HttpClientTelemetryEvent {
        method: HttpMethod::Post,
        outcome: HttpTransportOutcome::Response {
            status_class: HttpStatusClass::Success,
        },
        request_body_bytes: 11,
        response_body_bytes: 23,
        elapsed: Duration::from_millis(8),
    });

    let snapshot = telemetry.snapshot();
    assert_eq!(snapshot.operation_count, 2);
    assert_eq!(snapshot.http_attempt_count, 1);
    assert_eq!(snapshot.operations[0].operation, "model.operation");
    assert_eq!(snapshot.operations[0].count, 2);
    assert_eq!(snapshot.operations[0].succeeded, 1);
    assert_eq!(snapshot.operations[0].failed, 1);
    assert_eq!(snapshot.operations[0].total_elapsed_ms, 32);
    assert_eq!(snapshot.operations[0].max_elapsed_ms, 20);
    assert_eq!(snapshot.http_attempts[0].method, HttpMethodKind::Post);
    assert_eq!(
        snapshot.http_attempts[0].result,
        HttpAttemptResult::Response {
            status_class: HttpStatusClassKind::Success,
        }
    );
    assert_eq!(snapshot.http_attempts[0].request_body_bytes, 11);
    assert_eq!(snapshot.http_attempts[0].response_body_bytes, 23);

    let exported = telemetry
        .otel_exported_counts()
        .expect("flush OTel mock exporters");
    assert!(exported.metric_batches >= 1);
    assert_eq!(exported.spans, 3);
}

#[test]
fn keeps_recent_events_bounded_and_can_clear_state() {
    let telemetry = MockOtelProvider::new(NonZeroUsize::new(2).unwrap());
    for elapsed_ms in [1, 2, 3] {
        telemetry.record_event(TelemetryEvent::Operation {
            operation: "model.operation",
            outcome: OperationOutcome::Succeeded,
            elapsed_ms,
        });
    }

    let snapshot = telemetry.snapshot();
    assert_eq!(snapshot.recent_events.len(), 2);
    assert_eq!(
        snapshot.recent_events[0],
        TelemetryEvent::Operation {
            operation: "model.operation",
            outcome: OperationOutcome::Succeeded,
            elapsed_ms: 2,
        }
    );
    telemetry.clear();
    assert_eq!(telemetry.snapshot().operation_count, 0);
    assert!(telemetry.snapshot().recent_events.is_empty());
}

#[test]
fn snapshot_serialization_contains_only_safe_fields() {
    let telemetry = MockOtelProvider::default();
    telemetry.record_event(TelemetryEvent::HttpAttempt {
        method: HttpMethodKind::Post,
        result: HttpAttemptResult::TransportFailure,
        request_body_bytes: 42,
        response_body_bytes: 0,
        elapsed_ms: 7,
    });

    let json = serde_json::to_string(&telemetry.snapshot()).unwrap();
    assert!(json.contains("request_body_bytes"));
    assert!(json.contains("response_body_bytes"));
    for forbidden in [
        "url",
        "headers",
        "prompt",
        "secret",
        "tool_arguments",
        "diff",
    ] {
        assert!(
            !json.contains(forbidden),
            "serialized telemetry contains {forbidden}"
        );
    }
}
