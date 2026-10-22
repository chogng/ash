//! Production OpenTelemetry provider and a bounded local diagnostic exporter.

mod provider;
pub use provider::OutboundTrace;
pub use provider::Telemetry;
pub use provider::TelemetrySpan;
pub use provider::measure_current;

#[cfg(feature = "mock")]
pub mod mock;
