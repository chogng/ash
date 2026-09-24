use crate::HttpBodySink;
use crate::HttpClient;
use crate::HttpClientError;
use crate::HttpMethod;
use crate::HttpRequest;
use crate::HttpResponse;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A low-cardinality classification of an HTTP response status.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HttpStatusClass {
    Informational,
    Success,
    Redirection,
    ClientError,
    ServerError,
    Other,
}

impl HttpStatusClass {
    fn from_status(status: u16) -> Self {
        match status {
            100..=199 => Self::Informational,
            200..=299 => Self::Success,
            300..=399 => Self::Redirection,
            400..=499 => Self::ClientError,
            500..=599 => Self::ServerError,
            _ => Self::Other,
        }
    }
}

/// A safe outcome classification for one raw transport attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HttpTransportOutcome {
    Response { status_class: HttpStatusClass },
    TransportFailure,
}

/// Non-sensitive telemetry emitted for a single raw HTTP transport attempt.
///
/// URL, headers, certificate material, request body, and response body are
/// intentionally absent. Byte counts, method, response status class, and
/// elapsed time are safe for aggregate transport metrics.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HttpClientTelemetryEvent {
    pub method: HttpMethod,
    pub outcome: HttpTransportOutcome,
    pub request_body_bytes: usize,
    pub response_body_bytes: usize,
    pub elapsed: Duration,
}

/// Receives safe, low-cardinality facts about raw HTTP transport attempts.
///
/// Implementations may forward these events to logging, tracing, or metrics,
/// but must not combine them with URLs, header values, TLS material, or raw
/// protocol payloads.
pub trait HttpClientTelemetry: Send + Sync {
    fn start(&self) -> Box<dyn HttpClientTelemetrySpan + '_>;
}

/// Owns one HTTP attempt's instrumentation and restores the caller's context when dropped.
pub trait HttpClientTelemetrySpan {
    fn finish(self: Box<Self>, event: HttpClientTelemetryEvent);
}

/// Adds safe transport telemetry around a raw HTTP client without changing its behavior.
pub struct TelemetryHttpClient {
    inner: Arc<dyn HttpClient>,
    telemetry: Arc<dyn HttpClientTelemetry>,
}

impl TelemetryHttpClient {
    pub fn new(inner: Arc<dyn HttpClient>, telemetry: Arc<dyn HttpClientTelemetry>) -> Self {
        Self { inner, telemetry }
    }

    fn record_execute(
        &self,
        request: &HttpRequest,
        send: impl FnOnce(&dyn HttpClient, &HttpRequest) -> Result<HttpResponse, HttpClientError>,
    ) -> Result<HttpResponse, HttpClientError> {
        let span = self.telemetry.start();
        let started = Instant::now();
        let result = send(self.inner.as_ref(), request);
        let (outcome, response_body_bytes) = match &result {
            Ok(response) => (
                HttpTransportOutcome::Response {
                    status_class: HttpStatusClass::from_status(response.status()),
                },
                response.body().len(),
            ),
            Err(_) => (HttpTransportOutcome::TransportFailure, 0),
        };
        span.finish(HttpClientTelemetryEvent {
            method: request.method(),
            outcome,
            request_body_bytes: request.body().len(),
            response_body_bytes,
            elapsed: started.elapsed(),
        });
        result
    }

    fn record_streaming(
        &self,
        request: &HttpRequest,
        sink: &mut dyn HttpBodySink,
        send: impl FnOnce(
            &dyn HttpClient,
            &HttpRequest,
            &mut dyn HttpBodySink,
        ) -> Result<HttpResponse, HttpClientError>,
    ) -> Result<HttpResponse, HttpClientError> {
        let span = self.telemetry.start();
        let started = Instant::now();
        let mut counting_sink = CountingHttpBodySink {
            inner: sink,
            emitted_bytes: 0,
        };
        let result = send(self.inner.as_ref(), request, &mut counting_sink);
        let (outcome, buffered_bytes) = match &result {
            Ok(response) => (
                HttpTransportOutcome::Response {
                    status_class: HttpStatusClass::from_status(response.status()),
                },
                response.body().len(),
            ),
            Err(_) => (HttpTransportOutcome::TransportFailure, 0),
        };
        span.finish(HttpClientTelemetryEvent {
            method: request.method(),
            outcome,
            request_body_bytes: request.body().len(),
            response_body_bytes: counting_sink.emitted_bytes.saturating_add(buffered_bytes),
            elapsed: started.elapsed(),
        });
        result
    }
}

impl HttpClient for TelemetryHttpClient {
    fn execute(&self, request: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        self.record_execute(request, |inner, request| inner.execute(request))
    }

    fn execute_with_cancellation(
        &self,
        request: &HttpRequest,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<HttpResponse, HttpClientError> {
        self.record_execute(request, |inner, request| {
            inner.execute_with_cancellation(request, cancellation)
        })
    }

    fn execute_streaming(
        &self,
        request: &HttpRequest,
        sink: &mut dyn HttpBodySink,
    ) -> Result<HttpResponse, HttpClientError> {
        self.record_streaming(request, sink, |inner, request, sink| {
            inner.execute_streaming(request, sink)
        })
    }

    fn execute_streaming_with_cancellation(
        &self,
        request: &HttpRequest,
        cancellation: &ash_async_utils::CancellationToken,
        sink: &mut dyn HttpBodySink,
    ) -> Result<HttpResponse, HttpClientError> {
        self.record_streaming(request, sink, |inner, request, sink| {
            inner.execute_streaming_with_cancellation(request, cancellation, sink)
        })
    }
}

struct CountingHttpBodySink<'a> {
    inner: &'a mut dyn HttpBodySink,
    emitted_bytes: usize,
}

impl HttpBodySink for CountingHttpBodySink<'_> {
    fn emit(&mut self, chunk: &[u8]) -> Result<(), HttpClientError> {
        self.inner.emit(chunk)?;
        self.emitted_bytes = self.emitted_bytes.saturating_add(chunk.len());
        Ok(())
    }
}
