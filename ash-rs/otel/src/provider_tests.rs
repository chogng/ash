use super::*;
use ash_async_utils::CancellationSource;
use ash_client::{AshClient, ClientError, ClientRequest, OperationStreamSink, RetryPolicy};
use ash_http_client::{HttpBodySink, HttpClient, HttpClientError, HttpRequest, HttpResponse};
use std::sync::Mutex;

#[derive(Clone, Debug, Default)]
struct Captured(Arc<Mutex<Vec<SpanData>>>);

impl SpanExporter for Captured {
    async fn export(&self, spans: Vec<SpanData>) -> opentelemetry_sdk::error::OTelSdkResult {
        self.0.lock().unwrap().extend(spans);
        Ok(())
    }
}

#[test]
fn production_sdk_exports_to_bounded_diagnostics() {
    let diagnostics = Diagnostics::default();
    let telemetry = Telemetry::new(diagnostics.clone());
    let span = telemetry.start(Activity::Model);
    assert!(diagnostics.snapshot(Default::default()).recent.is_empty());
    span.finish(Outcome::Failed);
    telemetry.flush().unwrap();
    let snapshot = diagnostics.snapshot(Default::default());
    assert_eq!(snapshot.recent.len(), 1);
    assert_eq!(snapshot.recent[0].activity, Activity::Model);
    assert_eq!(snapshot.recent[0].outcome, Outcome::Failed);
}

struct Transport;

impl HttpClient for Transport {
    fn execute(&self, _: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        Ok(HttpResponse::new(200, vec![], b"private-response".to_vec()))
    }
    fn execute_streaming(
        &self,
        request: &HttpRequest,
        sink: &mut dyn HttpBodySink,
    ) -> Result<HttpResponse, HttpClientError> {
        sink.emit(b"private-chunk")?;
        self.execute(request)
    }
}

struct Sink;
impl OperationStreamSink for Sink {
    fn emit(&mut self, _: &[u8]) -> Result<(), ClientError> {
        Ok(())
    }
}

#[test]
fn rpc_model_and_http_share_parents_across_cancellable_transport_workers() {
    let captured = Captured::default();
    let telemetry = Telemetry::with_exporter(Diagnostics::default(), captured.clone());
    let transport = telemetry.instrument_http(Arc::new(Transport));
    let client = telemetry.instrument_model(Arc::new(AshClient::new(transport)));
    let request = ClientRequest::post(
        "https://private-host.test/",
        vec![],
        b"private-prompt".to_vec(),
        RetryPolicy::never(),
    )
    .unwrap();
    let cancellation = CancellationSource::new();
    let mut previous_trace = None;
    for streaming in [false, true] {
        let rpc = telemetry.start(Activity::Rpc);
        if streaming {
            client
                .execute_streaming_with_cancellation(&request, &cancellation.token(), &mut Sink)
                .unwrap();
        } else {
            client
                .execute_with_cancellation(&request, &cancellation.token())
                .unwrap();
        }
        rpc.finish(Outcome::Succeeded);
        telemetry.flush().unwrap();
        let spans = std::mem::take(&mut *captured.0.lock().unwrap());
        assert_eq!(spans.len(), 3);
        let http = spans.iter().find(|span| span.name == "http").unwrap();
        let model = spans.iter().find(|span| span.name == "model").unwrap();
        let rpc = spans.iter().find(|span| span.name == "rpc").unwrap();
        assert_eq!(http.parent_span_id, model.span_context.span_id());
        assert_eq!(model.parent_span_id, rpc.span_context.span_id());
        assert_eq!(http.span_context.trace_id(), rpc.span_context.trace_id());
        assert_eq!(model.span_context.trace_id(), rpc.span_context.trace_id());
        assert_ne!(previous_trace, Some(rpc.span_context.trace_id()));
        previous_trace = Some(rpc.span_context.trace_id());
        assert_eq!(rpc.parent_span_id, opentelemetry::trace::SpanId::INVALID);
        assert!(rpc.start_time <= model.start_time && model.start_time <= http.start_time);
        assert!(http.end_time <= model.end_time && model.end_time <= rpc.end_time);
        for span in spans {
            assert_eq!(span.attributes, vec![KeyValue::new("outcome", "succeeded")]);
            assert_eq!(span.status, Status::Ok);
        }
        assert!(!Context::current().span().span_context().is_valid());
    }
}

#[test]
fn unfinished_scope_is_failed_and_restores_parent() {
    let captured = Captured::default();
    let telemetry = Telemetry::with_exporter(Diagnostics::default(), captured.clone());
    let parent = telemetry.start(Activity::Rpc);
    let parent_id = Context::current().span().span_context().span_id();
    drop(telemetry.start(Activity::Model));
    assert_eq!(
        Context::current().span().span_context().span_id(),
        parent_id
    );
    parent.finish(Outcome::Cancelled);
    telemetry.flush().unwrap();
    let spans = captured.0.lock().unwrap();
    assert_eq!(
        spans[0].attributes,
        vec![KeyValue::new("outcome", "failed")]
    );
    assert_eq!(spans[1].status, Status::error("cancelled"));
}
