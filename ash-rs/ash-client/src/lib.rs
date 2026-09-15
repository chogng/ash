//! Provider-neutral operation execution, retry policy, framing, and telemetry values.
//!
//! This crate builds provider operations on `ash-http-client`: it owns replay
//! policy, SSE framing, and operation telemetry, while raw network transport
//! configuration and request execution remain in the lower crate.

mod error;
mod operation;
mod retry;
mod sse;
mod target;
mod telemetry;

pub use error::ClientError;
pub use operation::AshClient;
pub use operation::ClientRequest;
pub use operation::ClientResponse;
pub use operation::OperationClient;
pub use operation::OperationStreamSink;
pub use retry::BackoffPolicy;
pub use retry::RetryPolicy;
pub use retry::RetrySafety;
pub use sse::SseDecoder;
pub use sse::SseEvent;
pub use sse::SseFrame;
pub use target::ResolvedApiTarget;
pub use telemetry::ClientOperation;
pub use telemetry::ClientTelemetry;
pub use telemetry::ClientTelemetryEvent;
pub use telemetry::ClientTelemetryOutcome;
pub use telemetry::TelemetryOperationClient;

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
