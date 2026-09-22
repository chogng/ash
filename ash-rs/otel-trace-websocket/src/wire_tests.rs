use super::*;
use serde_json::json;

#[test]
fn serialization_rejects_oversized_frames_without_retaining_them() {
    let span = SpanData {
        span_context: opentelemetry::trace::SpanContext::empty_context(),
        parent_span_id: opentelemetry::trace::SpanId::INVALID,
        parent_span_is_remote: false,
        span_kind: SpanKind::Internal,
        name: "oversized".into(),
        start_time: UNIX_EPOCH,
        end_time: UNIX_EPOCH,
        attributes: vec![KeyValue::new("large", "x".repeat(crate::MAX_FRAME_BYTES))],
        dropped_attributes_count: 0,
        events: Default::default(),
        links: Default::default(),
        status: Status::Unset,
        instrumentation_scope: InstrumentationScope::builder("test").build(),
    };
    let resource = Resource::builder_empty().build();
    let mut output = BoundedFrame(Vec::new());
    let error = serde_json::to_writer(
        &mut output,
        &Frame {
            span: &span,
            resource: &resource,
            sequence: 1,
        },
    )
    .unwrap_err();
    assert!(error.to_string().contains("64 KiB"));
    assert!(output.0.len() <= crate::MAX_FRAME_BYTES);
}

#[test]
fn numeric_arrays_and_negative_timestamps_preserve_precision() {
    let integers = Value::Array(Array::I64(vec![i64::MIN, i64::MAX]));
    let floats = Value::Array(Array::F64(vec![f64::NAN, f64::INFINITY]));
    assert_eq!(
        serde_json::to_value(AttributeValue(&integers)).unwrap(),
        json!({"type":"int[]","value":[i64::MIN.to_string(),i64::MAX.to_string()]})
    );
    assert_eq!(
        serde_json::to_value(AttributeValue(&floats)).unwrap(),
        json!({"type":"double[]","value":["NaN","inf"]})
    );
    assert_eq!(
        timestamp(UNIX_EPOCH - std::time::Duration::from_nanos(100)),
        "-100"
    );
}
