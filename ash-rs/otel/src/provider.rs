use diagnostics::Activity;
use diagnostics::Diagnostics;
use diagnostics::Observation;
use diagnostics::Outcome;
use opentelemetry::KeyValue;
use opentelemetry::trace::Span;
use opentelemetry::trace::Tracer;
use opentelemetry::trace::TracerProvider;
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::trace::SpanData;
use opentelemetry_sdk::trace::SpanExporter;
use std::sync::Arc;
use std::time::Duration;
use std::time::SystemTime;

#[derive(Clone)]
pub struct Telemetry {
    provider: SdkTracerProvider,
}

impl Telemetry {
    pub fn new(diagnostics: Diagnostics) -> Self {
        Self {
            provider: SdkTracerProvider::builder()
                .with_simple_exporter(LocalExporter(diagnostics))
                .build(),
        }
    }

    /// Adds a host-owned exporter while retaining local diagnostic observations.
    pub fn with_exporter(diagnostics: Diagnostics, exporter: impl SpanExporter + 'static) -> Self {
        Self {
            provider: SdkTracerProvider::builder()
                .with_simple_exporter(LocalExporter(diagnostics))
                .with_simple_exporter(exporter)
                .build(),
        }
    }

    pub fn record(&self, activity: Activity, outcome: Outcome, elapsed: Duration) {
        let tracer = self.provider.tracer("ash");
        let end = SystemTime::now();
        let mut span = tracer
            .span_builder(match activity {
                Activity::Rpc => "rpc",
                Activity::Model => "model",
                Activity::Http => "http",
            })
            .with_start_time(end - elapsed)
            .with_end_time(end)
            .with_attributes([KeyValue::new(
                "outcome",
                match outcome {
                    Outcome::Succeeded => "succeeded",
                    Outcome::Failed => "failed",
                    Outcome::Cancelled => "cancelled",
                },
            )])
            .start(&tracer);
        span.end_with_timestamp(end);
    }

    pub fn instrument_http(
        &self,
        client: Arc<dyn ash_http_client::HttpClient>,
    ) -> Arc<dyn ash_http_client::HttpClient> {
        Arc::new(ash_http_client::TelemetryHttpClient::new(
            client,
            Arc::new(self.clone()),
        ))
    }

    pub fn instrument_model(
        &self,
        client: Arc<dyn ash_client::OperationClient>,
    ) -> Arc<dyn ash_client::OperationClient> {
        Arc::new(ash_client::TelemetryOperationClient::new(
            client,
            Arc::new(self.clone()),
            ash_client::ClientOperation::new("model"),
        ))
    }

    pub fn flush(&self) -> Result<(), String> {
        self.provider
            .force_flush()
            .map_err(|error| error.to_string())
    }
}

impl ash_client::ClientTelemetry for Telemetry {
    fn record(&self, event: ash_client::ClientTelemetryEvent) {
        self.record(
            Activity::Model,
            match event.outcome {
                ash_client::ClientTelemetryOutcome::Succeeded => Outcome::Succeeded,
                ash_client::ClientTelemetryOutcome::Failed => Outcome::Failed,
                ash_client::ClientTelemetryOutcome::Cancelled => Outcome::Cancelled,
            },
            event.elapsed,
        );
    }
}

impl ash_http_client::HttpClientTelemetry for Telemetry {
    fn record(&self, event: ash_http_client::HttpClientTelemetryEvent) {
        self.record(
            Activity::Http,
            match event.outcome {
                ash_http_client::HttpTransportOutcome::Response {
                    status_class: ash_http_client::HttpStatusClass::Success,
                } => Outcome::Succeeded,
                _ => Outcome::Failed,
            },
            event.elapsed,
        );
    }
}

#[derive(Debug)]
struct LocalExporter(Diagnostics);

impl SpanExporter for LocalExporter {
    async fn export(&self, batch: Vec<SpanData>) -> opentelemetry_sdk::error::OTelSdkResult {
        for span in batch {
            let activity = match span.name.as_ref() {
                "rpc" => Activity::Rpc,
                "model" => Activity::Model,
                "http" => Activity::Http,
                _ => continue,
            };
            let outcome = span
                .attributes
                .iter()
                .find(|attribute| attribute.key.as_str() == "outcome")
                .map(|attribute| attribute.value.as_str());
            let outcome = match outcome.as_deref() {
                Some("succeeded") => Outcome::Succeeded,
                Some("cancelled") => Outcome::Cancelled,
                Some("failed") => Outcome::Failed,
                _ => continue,
            };
            let Ok(elapsed) = span.end_time.duration_since(span.start_time) else {
                continue;
            };
            self.0.record(Observation {
                activity,
                outcome,
                elapsed_ms: elapsed.as_millis().min(u64::MAX as u128) as u64,
            });
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "provider_tests.rs"]
mod tests;
