use super::*;
use opentelemetry::trace::{
    SpanContext, SpanId, SpanKind, Status, TraceFlags, TraceId, TraceState,
};
use opentelemetry::{Array, InstrumentationScope, KeyValue};
use std::time::{Duration, UNIX_EPOCH};

fn span() -> SpanData {
    SpanData {
        span_context: SpanContext::new(
            TraceId::from(1),
            SpanId::from(2),
            TraceFlags::SAMPLED,
            false,
            TraceState::default(),
        ),
        parent_span_id: SpanId::from(3),
        parent_span_is_remote: false,
        span_kind: SpanKind::Client,
        name: "http".into(),
        start_time: UNIX_EPOCH + Duration::from_nanos(1_700_000_000_000_000_100),
        end_time: UNIX_EPOCH + Duration::from_nanos(1_700_000_000_000_004_300),
        attributes: vec![KeyValue::new(
            "integers",
            opentelemetry::Value::Array(Array::I64(vec![i64::MIN, i64::MAX])),
        )],
        dropped_attributes_count: 0,
        events: Default::default(),
        links: Default::default(),
        status: Status::Ok,
        instrumentation_scope: InstrumentationScope::builder("test").build(),
    }
}

#[test]
fn otlp_json_roundtrips_through_official_message_types_without_precision_loss() {
    let encoded = encode(span(), &Resource::builder_empty().build()).unwrap();
    let request: ExportTraceServiceRequest = serde_json::from_str(&encoded).unwrap();
    let decoded = &request.resource_spans[0].scope_spans[0].spans[0];
    assert_eq!(decoded.trace_id, TraceId::from(1).to_bytes());
    assert_eq!(decoded.span_id, SpanId::from(2).to_bytes());
    assert_eq!(decoded.parent_span_id, SpanId::from(3).to_bytes());
    assert_eq!(decoded.start_time_unix_nano, 1_700_000_000_000_000_100);
    assert_eq!(decoded.end_time_unix_nano, 1_700_000_000_000_004_300);
    assert_eq!(decoded.kind, 3);
    let json: serde_json::Value = serde_json::from_str(&encoded).unwrap();
    let values = &json["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["attributes"][0]["value"]["arrayValue"]
        ["values"];
    assert_eq!(values[0]["intValue"], i64::MIN.to_string());
    assert_eq!(values[1]["intValue"], i64::MAX.to_string());
}

#[test]
fn serialization_rejects_oversized_frames_without_retaining_them() {
    let mut span = span();
    span.attributes = vec![KeyValue::new("large", "x".repeat(crate::MAX_FRAME_BYTES))];
    let error = encode(span, &Resource::builder_empty().build()).unwrap_err();
    assert!(error.to_string().contains("64 KiB"));
    let mut output = BoundedFrame(Vec::new());
    assert!(
        output
            .write_all(&vec![0; crate::MAX_FRAME_BYTES + 1])
            .is_err()
    );
    assert!(output.0.is_empty());
}
