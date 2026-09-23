use super::*;
use ash_async_utils::CancellationSource;
use ash_http_client::HttpHeader;
use std::num::NonZeroU8;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

#[test]
fn target_rejects_a_non_http_base_url() {
    let target = ResolvedApiTarget::new("file:///tmp/ash", Vec::new());
    assert!(matches!(
        target.endpoint("responses"),
        Err(ClientError::InvalidRequest(_))
    ));
}

#[test]
fn retry_policy_never_replays_inference_by_default() {
    let policy = RetryPolicy::never();
    assert_eq!(policy.safety(), RetrySafety::Never);
    assert_eq!(policy.max_attempts(), NonZeroU8::MIN);
}

#[test]
fn retry_backoff_is_bounded() {
    let backoff = BackoffPolicy::new(Duration::from_millis(50), Duration::from_millis(120));
    assert_eq!(backoff.delay_before_retry(0), Duration::from_millis(50));
    assert_eq!(backoff.delay_before_retry(1), Duration::from_millis(100));
    assert_eq!(backoff.delay_before_retry(2), Duration::from_millis(120));
}

#[test]
fn cancellation_stops_waiting_for_an_active_transport_attempt() {
    let transport = Arc::new(BlockingHttpClient::default());
    let client = AshClient::new(transport.clone());
    let request = ClientRequest::post(
        "https://example.test/responses",
        Vec::new(),
        Vec::new(),
        RetryPolicy::never(),
    )
    .unwrap();
    let cancellation = CancellationSource::new();
    let canceller_source = cancellation.clone();
    let canceller_transport = transport.clone();
    let canceller = std::thread::spawn(move || {
        canceller_transport.wait_until_entered();
        canceller_source.cancel();
    });

    let result = client.execute_with_cancellation(&request, &cancellation.token());

    assert!(matches!(result, Err(ClientError::Cancelled(_))));
    transport.release();
    transport.wait_until_finished();
    canceller.join().unwrap();
}

#[test]
fn streaming_transport_failure_after_a_chunk_is_never_replayed() {
    let transport = Arc::new(PartialStreamingHttpClient::default());
    let client = AshClient::new(transport.clone());
    let request = ClientRequest::post(
        "https://example.test/responses",
        Vec::new(),
        Vec::new(),
        RetryPolicy::replayable(
            RetrySafety::Idempotent,
            NonZeroU8::new(2).unwrap(),
            BackoffPolicy::new(Duration::ZERO, Duration::ZERO),
        ),
    )
    .unwrap();
    let mut sink = CollectedBytes::default();

    let result = client.execute_streaming(&request, &mut sink);

    assert!(matches!(result, Err(ClientError::Transport(_))));
    assert_eq!(sink.bytes, b"partial");
    assert_eq!(transport.attempts.load(Ordering::Relaxed), 1);
}

#[test]
fn sse_decoder_joins_multiline_data_across_chunks() {
    let mut decoder = SseDecoder::new(1024).unwrap();
    assert!(
        decoder
            .push(b"event: update\r\ndata: first")
            .unwrap()
            .is_empty()
    );
    let frames = decoder.push(b"\r\ndata: second\r\n\r\n").unwrap();

    assert_eq!(
        frames,
        vec![SseFrame::Event(SseEvent {
            event: Some("update".into()),
            data: "first\nsecond".into(),
            id: None,
            retry: None,
        })]
    );
    decoder.finish().unwrap();
}

#[test]
fn sse_decoder_keeps_comments_separate_from_protocol_events() {
    let mut decoder = SseDecoder::new(1024).unwrap();
    let frames = decoder.push(b": keep-alive\n\ndata: [DONE]\n\n").unwrap();

    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0], SseFrame::Comment);
    assert_eq!(
        frames[1],
        SseFrame::Event(SseEvent {
            event: None,
            data: "[DONE]".into(),
            id: None,
            retry: None,
        })
    );
}

#[test]
fn telemetry_client_records_only_safe_operation_metadata() {
    let telemetry = Arc::new(CapturingTelemetry::default());
    let client = TelemetryOperationClient::new(
        Arc::new(StaticClient),
        telemetry.clone(),
        ClientOperation::new("model.inference.openai_responses"),
    );

    client
        .execute(
            &ClientRequest::post(
                "https://example.test/responses",
                vec![HttpHeader::new("Authorization", "Bearer secret")],
                br#"{"input":"private prompt"}"#.to_vec(),
                RetryPolicy::never(),
            )
            .unwrap(),
        )
        .unwrap();

    let event = telemetry.events.lock().unwrap()[0];
    assert_eq!(event.operation.name(), "model.inference.openai_responses");
    assert_eq!(event.outcome, ClientTelemetryOutcome::Succeeded);
}

#[derive(Default)]
struct CapturingTelemetry {
    events: Mutex<Vec<ClientTelemetryEvent>>,
}

impl ClientTelemetry for CapturingTelemetry {
    fn start(&self, _: ClientOperation) -> Box<dyn crate::ClientTelemetrySpan + '_> {
        Box::new(self)
    }
}

impl crate::ClientTelemetrySpan for &CapturingTelemetry {
    fn finish(self: Box<Self>, event: ClientTelemetryEvent) {
        self.events.lock().unwrap().push(event);
    }
}

struct StaticClient;

#[test]
fn unary_operation_clients_reject_streaming_before_sending() {
    struct UnaryOnly;
    impl OperationClient for UnaryOnly {
        fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
            panic!("a streaming request must not execute a unary operation")
        }
    }
    let request = ClientRequest::post(
        "https://example.test/stream",
        Vec::new(),
        Vec::new(),
        RetryPolicy::never(),
    )
    .unwrap();
    let mut sink = CollectedBytes::default();
    assert_eq!(
        UnaryOnly.execute_streaming(&request, &mut sink),
        Err(ClientError::InvalidRequest(
            "operation client does not support streaming".into()
        ))
    );
    assert!(sink.bytes.is_empty());
}

impl OperationClient for StaticClient {
    fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
        Ok(ClientResponse::new(
            200,
            Vec::new(),
            br#"{"ok":true}"#.to_vec(),
        ))
    }
}

#[derive(Default)]
struct CollectedBytes {
    bytes: Vec<u8>,
}

impl OperationStreamSink for CollectedBytes {
    fn emit(&mut self, chunk: &[u8]) -> Result<(), ClientError> {
        self.bytes.extend_from_slice(chunk);
        Ok(())
    }
}

#[derive(Default)]
struct PartialStreamingHttpClient {
    attempts: AtomicUsize,
}

impl ash_http_client::HttpClient for PartialStreamingHttpClient {
    fn execute(
        &self,
        _: &ash_http_client::HttpRequest,
    ) -> Result<ClientResponse, ash_http_client::HttpClientError> {
        panic!("streaming operation must use the streaming transport path")
    }

    fn execute_streaming(
        &self,
        _: &ash_http_client::HttpRequest,
        sink: &mut dyn ash_http_client::HttpBodySink,
    ) -> Result<ClientResponse, ash_http_client::HttpClientError> {
        self.attempts.fetch_add(1, Ordering::Relaxed);
        sink.emit(b"partial")?;
        Err(ash_http_client::HttpClientError::Transport(
            "fixture stream interrupted".into(),
        ))
    }
}

#[derive(Default)]
struct BlockingHttpClient {
    state: Mutex<BlockingHttpState>,
    changed: Condvar,
}

#[derive(Default)]
struct BlockingHttpState {
    entered: bool,
    released: bool,
    finished: bool,
}

impl BlockingHttpClient {
    fn wait_until_entered(&self) {
        let mut state = self.state.lock().unwrap();
        while !state.entered {
            state = self.changed.wait(state).unwrap();
        }
    }

    fn release(&self) {
        let mut state = self.state.lock().unwrap();
        state.released = true;
        self.changed.notify_all();
    }

    fn wait_until_finished(&self) {
        let mut state = self.state.lock().unwrap();
        while !state.finished {
            state = self.changed.wait(state).unwrap();
        }
    }
}

impl ash_http_client::HttpClient for BlockingHttpClient {
    fn execute(
        &self,
        _: &ash_http_client::HttpRequest,
    ) -> Result<ClientResponse, ash_http_client::HttpClientError> {
        let mut state = self.state.lock().unwrap();
        state.entered = true;
        self.changed.notify_all();
        while !state.released {
            state = self.changed.wait(state).unwrap();
        }
        state.finished = true;
        self.changed.notify_all();
        Ok(ClientResponse::new(200, Vec::new(), Vec::new()))
    }
}
