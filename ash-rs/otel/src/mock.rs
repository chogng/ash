//! Feature-gated OpenTelemetry in-memory provider for tests and monitor experiments.
//!
//! This module performs no network I/O and is excluded from default builds.

use ash_client::ClientOperation;
use ash_client::ClientTelemetry;
use ash_client::ClientTelemetryEvent;
use ash_client::ClientTelemetryOutcome;
use ash_client::OperationClient;
use ash_client::TelemetryOperationClient;
use ash_http_client::HttpClient;
use ash_http_client::HttpClientTelemetry;
use ash_http_client::HttpClientTelemetryEvent;
use ash_http_client::HttpMethod;
use ash_http_client::HttpStatusClass;
use ash_http_client::HttpTransportOutcome;
use ash_http_client::TelemetryHttpClient;
use opentelemetry::KeyValue;
use opentelemetry::metrics::Counter;
use opentelemetry::metrics::Histogram;
use opentelemetry::metrics::MeterProvider as _;
use opentelemetry::trace::Span as _;
use opentelemetry::trace::Tracer as _;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_sdk::metrics::InMemoryMetricExporter;
use opentelemetry_sdk::metrics::PeriodicReader;
use opentelemetry_sdk::metrics::SdkMeterProvider;
use opentelemetry_sdk::trace::InMemorySpanExporter;
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::trace::Tracer;
use serde::Serialize;
use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::num::NonZeroUsize;
use std::sync::Arc;
use std::sync::Mutex;

/// A safe, low-cardinality result classification for one operation.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationOutcome {
    Succeeded,
    Cancelled,
    Failed,
}

/// A safe, low-cardinality result classification for one HTTP attempt.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HttpAttemptResult {
    Response { status_class: HttpStatusClassKind },
    TransportFailure,
}

/// HTTP status classes that can be safely grouped by a monitor.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HttpStatusClassKind {
    Informational,
    Success,
    Redirection,
    ClientError,
    ServerError,
    Other,
}

/// HTTP methods currently supported by the shared transport.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HttpMethodKind {
    Get,
    Post,
    Delete,
}

/// One safe event retained by the in-memory monitor view.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TelemetryEvent {
    Operation {
        operation: &'static str,
        outcome: OperationOutcome,
        elapsed_ms: u64,
    },
    HttpAttempt {
        method: HttpMethodKind,
        result: HttpAttemptResult,
        request_body_bytes: u64,
        response_body_bytes: u64,
        elapsed_ms: u64,
    },
}

/// Aggregated observations for one low-cardinality operation name.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct OperationSummary {
    pub operation: &'static str,
    pub count: u64,
    pub succeeded: u64,
    pub cancelled: u64,
    pub failed: u64,
    pub total_elapsed_ms: u64,
    pub max_elapsed_ms: u64,
}

/// Aggregated observations for one HTTP method/result class pair.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct HttpAttemptSummary {
    pub method: HttpMethodKind,
    pub result: HttpAttemptResult,
    pub count: u64,
    pub request_body_bytes: u64,
    pub response_body_bytes: u64,
    pub total_elapsed_ms: u64,
    pub max_elapsed_ms: u64,
}

/// A monitor-friendly copy of the bounded in-memory state.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TelemetrySnapshot {
    pub operation_count: u64,
    pub http_attempt_count: u64,
    pub operations: Vec<OperationSummary>,
    pub http_attempts: Vec<HttpAttemptSummary>,
    pub recent_events: Vec<TelemetryEvent>,
}

/// Counts of data accepted by the mock OpenTelemetry exporters.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct OtelExportCounts {
    pub metric_batches: u64,
    pub spans: u64,
}

/// OpenTelemetry-backed in-process provider used by local diagnostics and tests.
#[derive(Clone)]
pub struct MockOtelProvider {
    inner: Arc<MockOtelProviderInner>,
}

struct MockOtelProviderInner {
    state: Mutex<SnapshotState>,
    recent_event_limit: NonZeroUsize,
    meter_provider: SdkMeterProvider,
    tracer_provider: SdkTracerProvider,
    tracer: Tracer,
    operation_count: Counter<u64>,
    operation_duration_ms: Histogram<f64>,
    http_attempt_count: Counter<u64>,
    http_attempt_duration_ms: Histogram<f64>,
    http_request_body_bytes: Counter<u64>,
    http_response_body_bytes: Counter<u64>,
    metric_exporter: InMemoryMetricExporter,
    span_exporter: InMemorySpanExporter,
}

impl Default for MockOtelProvider {
    fn default() -> Self {
        Self::new(NonZeroUsize::new(256).expect("the default telemetry limit is non-zero"))
    }
}

impl MockOtelProvider {
    /// Creates an OTel provider with a bounded monitor snapshot and in-memory exporters.
    pub fn new(recent_event_limit: NonZeroUsize) -> Self {
        let metric_exporter = InMemoryMetricExporter::default();
        let metric_reader = PeriodicReader::builder(metric_exporter.clone()).build();
        let meter_provider = SdkMeterProvider::builder()
            .with_reader(metric_reader)
            .build();
        let meter = meter_provider.meter("ash-otel");

        let operation_count = meter.u64_counter("ash.operation.count").build();
        let operation_duration_ms = meter.f64_histogram("ash.operation.duration_ms").build();
        let http_attempt_count = meter.u64_counter("ash.http.attempt.count").build();
        let http_attempt_duration_ms = meter.f64_histogram("ash.http.attempt.duration_ms").build();
        let http_request_body_bytes = meter.u64_counter("ash.http.request.body_bytes").build();
        let http_response_body_bytes = meter.u64_counter("ash.http.response.body_bytes").build();

        let span_exporter = InMemorySpanExporter::default();
        let tracer_provider = SdkTracerProvider::builder()
            .with_simple_exporter(span_exporter.clone())
            .build();
        let tracer = tracer_provider.tracer("ash-otel");

        Self {
            inner: Arc::new(MockOtelProviderInner {
                state: Mutex::new(SnapshotState::default()),
                recent_event_limit,
                meter_provider,
                tracer_provider,
                tracer,
                operation_count,
                operation_duration_ms,
                http_attempt_count,
                http_attempt_duration_ms,
                http_request_body_bytes,
                http_response_body_bytes,
                metric_exporter,
                span_exporter,
            }),
        }
    }

    /// Records one already-sanitized event in both the monitor view and OTel SDK.
    pub fn record_event(&self, event: TelemetryEvent) {
        {
            let mut state = self
                .inner
                .state
                .lock()
                .expect("mock telemetry state lock poisoned");
            state.record_event(self.inner.recent_event_limit, &event);
        }
        self.record_otel_event(&event);
    }

    /// Returns a detached snapshot suitable for serialization or a local monitor response.
    pub fn snapshot(&self) -> TelemetrySnapshot {
        let state = self
            .inner
            .state
            .lock()
            .expect("mock telemetry state lock poisoned");
        state.snapshot()
    }

    /// Clears aggregate and recent-event state while keeping the configured buffer bound.
    pub fn clear(&self) {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("mock telemetry state lock poisoned");
        *state = SnapshotState::default();
    }

    /// Flushes the in-memory OTel metric and span exporters.
    pub fn force_flush(&self) -> Result<(), String> {
        self.inner
            .meter_provider
            .force_flush()
            .map_err(|error| error.to_string())?;
        self.inner
            .tracer_provider
            .force_flush()
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// Returns how many metric batches and spans the OTel mock exporters accepted.
    pub fn otel_exported_counts(&self) -> Result<OtelExportCounts, String> {
        self.force_flush()?;
        let metric_batches = self
            .inner
            .metric_exporter
            .get_finished_metrics()
            .map_err(|error| error.to_string())?
            .len();
        let spans = self
            .inner
            .span_exporter
            .get_finished_spans()
            .map_err(|error| error.to_string())?
            .len();
        Ok(OtelExportCounts {
            metric_batches: usize_to_u64(metric_batches),
            spans: usize_to_u64(spans),
        })
    }

    /// Wraps a raw HTTP client so every attempt is recorded in this provider.
    pub fn instrument_http_client(&self, client: Arc<dyn HttpClient>) -> Arc<dyn HttpClient> {
        let telemetry: Arc<dyn HttpClientTelemetry> = Arc::new(self.clone());
        Arc::new(TelemetryHttpClient::new(client, telemetry))
    }

    /// Wraps an operation client so every operation is recorded with one static name.
    pub fn instrument_operation_client(
        &self,
        client: Arc<dyn OperationClient>,
        operation: ClientOperation,
    ) -> Arc<dyn OperationClient> {
        let telemetry: Arc<dyn ClientTelemetry> = Arc::new(self.clone());
        Arc::new(TelemetryOperationClient::new(client, telemetry, operation))
    }

    fn record_otel_event(&self, event: &TelemetryEvent) {
        match event {
            TelemetryEvent::Operation {
                operation,
                outcome,
                elapsed_ms,
            } => {
                let outcome_name = operation_outcome_name(*outcome);
                let attributes = [
                    KeyValue::new("operation", *operation),
                    KeyValue::new("outcome", outcome_name),
                ];
                self.inner.operation_count.add(1, &attributes);
                self.inner
                    .operation_duration_ms
                    .record(*elapsed_ms as f64, &attributes);

                let mut span = self
                    .inner
                    .tracer
                    .span_builder("ash.operation")
                    .start(&self.inner.tracer);
                span.set_attribute(KeyValue::new("operation", *operation));
                span.set_attribute(KeyValue::new("outcome", outcome_name));
                span.end();
            }
            TelemetryEvent::HttpAttempt {
                method,
                result,
                request_body_bytes,
                response_body_bytes,
                elapsed_ms,
            } => {
                let method_name = http_method_name(*method);
                let result_name = http_attempt_result_name(*result);
                let status_class_name = http_status_class_name(*result);
                let attributes = [
                    KeyValue::new("method", method_name),
                    KeyValue::new("result", result_name),
                    KeyValue::new("status_class", status_class_name),
                ];
                self.inner.http_attempt_count.add(1, &attributes);
                self.inner
                    .http_attempt_duration_ms
                    .record(*elapsed_ms as f64, &attributes);
                self.inner
                    .http_request_body_bytes
                    .add(*request_body_bytes, &attributes);
                self.inner
                    .http_response_body_bytes
                    .add(*response_body_bytes, &attributes);

                let mut span = self
                    .inner
                    .tracer
                    .span_builder("ash.http_attempt")
                    .start(&self.inner.tracer);
                span.set_attribute(KeyValue::new("method", method_name));
                span.set_attribute(KeyValue::new("result", result_name));
                span.set_attribute(KeyValue::new("status_class", status_class_name));
                span.end();
            }
        }
    }
}

impl ClientTelemetry for MockOtelProvider {
    fn start(&self, _: ClientOperation) -> Box<dyn ash_client::ClientTelemetrySpan + '_> {
        Box::new(self)
    }
}

impl ash_client::ClientTelemetrySpan for &MockOtelProvider {
    fn finish(self: Box<Self>, event: ClientTelemetryEvent) {
        self.record_event(TelemetryEvent::Operation {
            operation: event.operation.name(),
            outcome: match event.outcome {
                ClientTelemetryOutcome::Succeeded => OperationOutcome::Succeeded,
                ClientTelemetryOutcome::Cancelled => OperationOutcome::Cancelled,
                ClientTelemetryOutcome::Failed => OperationOutcome::Failed,
            },
            elapsed_ms: elapsed_millis(event.elapsed),
        });
    }
}

impl HttpClientTelemetry for MockOtelProvider {
    fn start(&self) -> Box<dyn ash_http_client::HttpClientTelemetrySpan + '_> {
        Box::new(self)
    }
}

impl ash_http_client::HttpClientTelemetrySpan for &MockOtelProvider {
    fn finish(self: Box<Self>, event: HttpClientTelemetryEvent) {
        self.record_event(TelemetryEvent::HttpAttempt {
            method: match event.method {
                HttpMethod::Get => HttpMethodKind::Get,
                HttpMethod::Post => HttpMethodKind::Post,
                HttpMethod::Delete => HttpMethodKind::Delete,
            },
            result: match event.outcome {
                HttpTransportOutcome::Response { status_class } => HttpAttemptResult::Response {
                    status_class: status_class_kind(status_class),
                },
                HttpTransportOutcome::TransportFailure => HttpAttemptResult::TransportFailure,
            },
            request_body_bytes: usize_to_u64(event.request_body_bytes),
            response_body_bytes: usize_to_u64(event.response_body_bytes),
            elapsed_ms: elapsed_millis(event.elapsed),
        });
    }
}

#[derive(Default)]
struct SnapshotState {
    operation_count: u64,
    http_attempt_count: u64,
    operations: BTreeMap<&'static str, OperationSummary>,
    http_attempts: BTreeMap<(HttpMethodKind, HttpAttemptResult), HttpAttemptSummary>,
    recent_events: VecDeque<TelemetryEvent>,
}

impl SnapshotState {
    fn record_event(&mut self, recent_event_limit: NonZeroUsize, event: &TelemetryEvent) {
        match event {
            TelemetryEvent::Operation {
                operation,
                outcome,
                elapsed_ms,
            } => {
                self.operation_count = self.operation_count.saturating_add(1);
                let summary =
                    self.operations
                        .entry(*operation)
                        .or_insert_with(|| OperationSummary {
                            operation: *operation,
                            count: 0,
                            succeeded: 0,
                            cancelled: 0,
                            failed: 0,
                            total_elapsed_ms: 0,
                            max_elapsed_ms: 0,
                        });
                summary.count = summary.count.saturating_add(1);
                match outcome {
                    OperationOutcome::Succeeded => {
                        summary.succeeded = summary.succeeded.saturating_add(1)
                    }
                    OperationOutcome::Cancelled => {
                        summary.cancelled = summary.cancelled.saturating_add(1)
                    }
                    OperationOutcome::Failed => summary.failed = summary.failed.saturating_add(1),
                }
                summary.total_elapsed_ms = summary.total_elapsed_ms.saturating_add(*elapsed_ms);
                summary.max_elapsed_ms = summary.max_elapsed_ms.max(*elapsed_ms);
            }
            TelemetryEvent::HttpAttempt {
                method,
                result,
                request_body_bytes,
                response_body_bytes,
                elapsed_ms,
            } => {
                self.http_attempt_count = self.http_attempt_count.saturating_add(1);
                let summary = self
                    .http_attempts
                    .entry((*method, *result))
                    .or_insert_with(|| HttpAttemptSummary {
                        method: *method,
                        result: *result,
                        count: 0,
                        request_body_bytes: 0,
                        response_body_bytes: 0,
                        total_elapsed_ms: 0,
                        max_elapsed_ms: 0,
                    });
                summary.count = summary.count.saturating_add(1);
                summary.request_body_bytes = summary
                    .request_body_bytes
                    .saturating_add(*request_body_bytes);
                summary.response_body_bytes = summary
                    .response_body_bytes
                    .saturating_add(*response_body_bytes);
                summary.total_elapsed_ms = summary.total_elapsed_ms.saturating_add(*elapsed_ms);
                summary.max_elapsed_ms = summary.max_elapsed_ms.max(*elapsed_ms);
            }
        }
        if self.recent_events.len() >= recent_event_limit.get() {
            self.recent_events.pop_front();
        }
        self.recent_events.push_back(event.clone());
    }

    fn snapshot(&self) -> TelemetrySnapshot {
        TelemetrySnapshot {
            operation_count: self.operation_count,
            http_attempt_count: self.http_attempt_count,
            operations: self.operations.values().cloned().collect(),
            http_attempts: self.http_attempts.values().cloned().collect(),
            recent_events: self.recent_events.iter().cloned().collect(),
        }
    }
}

fn operation_outcome_name(outcome: OperationOutcome) -> &'static str {
    match outcome {
        OperationOutcome::Succeeded => "succeeded",
        OperationOutcome::Cancelled => "cancelled",
        OperationOutcome::Failed => "failed",
    }
}

fn http_method_name(method: HttpMethodKind) -> &'static str {
    match method {
        HttpMethodKind::Get => "get",
        HttpMethodKind::Post => "post",
        HttpMethodKind::Delete => "delete",
    }
}

fn http_attempt_result_name(result: HttpAttemptResult) -> &'static str {
    match result {
        HttpAttemptResult::Response { .. } => "response",
        HttpAttemptResult::TransportFailure => "transport_failure",
    }
}

fn http_status_class_name(result: HttpAttemptResult) -> &'static str {
    match result {
        HttpAttemptResult::Response { status_class } => match status_class {
            HttpStatusClassKind::Informational => "informational",
            HttpStatusClassKind::Success => "success",
            HttpStatusClassKind::Redirection => "redirection",
            HttpStatusClassKind::ClientError => "client_error",
            HttpStatusClassKind::ServerError => "server_error",
            HttpStatusClassKind::Other => "other",
        },
        HttpAttemptResult::TransportFailure => "none",
    }
}

fn status_class_kind(status_class: HttpStatusClass) -> HttpStatusClassKind {
    match status_class {
        HttpStatusClass::Informational => HttpStatusClassKind::Informational,
        HttpStatusClass::Success => HttpStatusClassKind::Success,
        HttpStatusClass::Redirection => HttpStatusClassKind::Redirection,
        HttpStatusClass::ClientError => HttpStatusClassKind::ClientError,
        HttpStatusClass::ServerError => HttpStatusClassKind::ServerError,
        HttpStatusClass::Other => HttpStatusClassKind::Other,
    }
}

fn elapsed_millis(duration: std::time::Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

fn usize_to_u64(value: usize) -> u64 {
    value.min(u64::MAX as usize) as u64
}

#[cfg(test)]
#[path = "otel_tests.rs"]
mod tests;
