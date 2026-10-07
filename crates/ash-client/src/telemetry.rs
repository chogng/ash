use crate::ClientError;
use crate::ClientRequest;
use crate::ClientResponse;
use crate::OperationClient;
use crate::OperationStreamSink;
use ash_async_utils::CancellationToken;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Low-cardinality, non-sensitive operation metadata for client telemetry.
///
/// The value is static so request URLs, model IDs, tenant identifiers, prompt
/// content, and credentials cannot accidentally become metric dimensions.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ClientOperation {
    name: &'static str,
}

impl ClientOperation {
    pub const fn new(name: &'static str) -> Self {
        Self { name }
    }

    pub const fn name(self) -> &'static str {
        self.name
    }
}

/// The safe result classification reported for one client operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClientTelemetryOutcome {
    Succeeded,
    Cancelled,
    Failed,
}

/// A safe telemetry record emitted after a provider operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ClientTelemetryEvent {
    pub operation: ClientOperation,
    pub outcome: ClientTelemetryOutcome,
    pub elapsed: Duration,
}

/// Receives transport-level telemetry without request or response payloads.
///
/// Implementations may bridge events to tracing or metrics systems, but must
/// preserve the supplied value boundary: they must not reconstruct or append
/// model IDs, URLs, headers, credentials, prompts, or response bodies.
pub trait ClientTelemetry: Send + Sync {
    fn start(&self, operation: ClientOperation) -> Box<dyn ClientTelemetrySpan + '_>;
}

/// Owns one operation's instrumentation on the calling thread, including its parent context.
pub trait ClientTelemetrySpan {
    fn finish(self: Box<Self>, event: ClientTelemetryEvent);
}

/// Adds safe telemetry around any unary provider operation client.
pub struct TelemetryOperationClient {
    inner: Arc<dyn OperationClient>,
    telemetry: Arc<dyn ClientTelemetry>,
    operation: ClientOperation,
}

impl TelemetryOperationClient {
    pub fn new(
        inner: Arc<dyn OperationClient>,
        telemetry: Arc<dyn ClientTelemetry>,
        operation: ClientOperation,
    ) -> Self {
        Self {
            inner,
            telemetry,
            operation,
        }
    }
}

impl OperationClient for TelemetryOperationClient {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.record(|| self.inner.execute(request))
    }

    fn execute_with_cancellation(
        &self,
        request: &ClientRequest,
        cancellation: &CancellationToken,
    ) -> Result<ClientResponse, ClientError> {
        self.record(|| self.inner.execute_with_cancellation(request, cancellation))
    }

    fn execute_streaming(
        &self,
        request: &ClientRequest,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        self.record(|| self.inner.execute_streaming(request, sink))
    }

    fn execute_streaming_with_cancellation(
        &self,
        request: &ClientRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        self.record(|| {
            self.inner
                .execute_streaming_with_cancellation(request, cancellation, sink)
        })
    }
}

impl TelemetryOperationClient {
    fn record<T>(
        &self,
        operation: impl FnOnce() -> Result<T, ClientError>,
    ) -> Result<T, ClientError> {
        let span = self.telemetry.start(self.operation);
        let started = Instant::now();
        let result = operation();
        let outcome = match &result {
            Ok(_) => ClientTelemetryOutcome::Succeeded,
            Err(ClientError::Cancelled(_)) => ClientTelemetryOutcome::Cancelled,
            Err(_) => ClientTelemetryOutcome::Failed,
        };
        span.finish(ClientTelemetryEvent {
            operation: self.operation,
            outcome,
            elapsed: started.elapsed(),
        });
        result
    }
}
