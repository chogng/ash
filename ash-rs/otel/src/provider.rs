use diagnostics::Activity;
use diagnostics::Diagnostics;
use diagnostics::Observation;
use diagnostics::Outcome;
use opentelemetry::Context;
use opentelemetry::ContextGuard;
use opentelemetry::KeyValue;
use opentelemetry::trace::SpanKind;
use opentelemetry::trace::Status;
use opentelemetry::trace::TraceContextExt;
use opentelemetry::trace::Tracer;
use opentelemetry::trace::TracerProvider;
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::trace::SpanData;
use opentelemetry_sdk::trace::SpanExporter;
use std::sync::Arc;

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

    /// Starts a span on this thread. The guard must remain within synchronous execution.
    pub fn start(&self, activity: Activity) -> TelemetrySpan {
        let span = self
            .provider
            .tracer("ash")
            .span_builder(match activity {
                Activity::Rpc => "rpc",
                Activity::Model => "model",
                Activity::Http => "http",
            })
            .with_kind(match activity {
                Activity::Rpc => SpanKind::Server,
                Activity::Model | Activity::Http => SpanKind::Client,
            })
            .start(&self.provider.tracer("ash"));
        let context = Context::current_with_span(span);
        let guard = context.clone().attach();
        TelemetrySpan {
            context,
            _guard: guard,
            outcome: Outcome::Failed,
        }
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

/// A synchronous span scope; dropping it ends the span and restores its parent.
pub struct TelemetrySpan {
    context: Context,
    _guard: ContextGuard,
    outcome: Outcome,
}

impl TelemetrySpan {
    pub fn finish(mut self, outcome: Outcome) {
        self.outcome = outcome;
    }
}

impl Drop for TelemetrySpan {
    fn drop(&mut self) {
        let span = self.context.span();
        span.set_attribute(KeyValue::new(
            "outcome",
            match self.outcome {
                Outcome::Succeeded => "succeeded",
                Outcome::Failed => "failed",
                Outcome::Cancelled => "cancelled",
            },
        ));
        span.set_status(match self.outcome {
            Outcome::Succeeded => Status::Ok,
            Outcome::Failed => Status::error("failed"),
            Outcome::Cancelled => Status::error("cancelled"),
        });
        span.end();
    }
}

impl ash_client::ClientTelemetry for Telemetry {
    fn start(
        &self,
        _: ash_client::ClientOperation,
    ) -> Box<dyn ash_client::ClientTelemetrySpan + '_> {
        Box::new(self.start(Activity::Model))
    }
}

impl ash_client::ClientTelemetrySpan for TelemetrySpan {
    fn finish(self: Box<Self>, event: ash_client::ClientTelemetryEvent) {
        TelemetrySpan::finish(
            *self,
            match event.outcome {
                ash_client::ClientTelemetryOutcome::Succeeded => Outcome::Succeeded,
                ash_client::ClientTelemetryOutcome::Failed => Outcome::Failed,
                ash_client::ClientTelemetryOutcome::Cancelled => Outcome::Cancelled,
            },
        );
    }
}

impl ash_http_client::HttpClientTelemetry for Telemetry {
    fn start(&self) -> Box<dyn ash_http_client::HttpClientTelemetrySpan + '_> {
        Box::new(self.start(Activity::Http))
    }
}

impl ash_http_client::HttpClientTelemetrySpan for TelemetrySpan {
    fn finish(self: Box<Self>, event: ash_http_client::HttpClientTelemetryEvent) {
        TelemetrySpan::finish(
            *self,
            match event.outcome {
                ash_http_client::HttpTransportOutcome::Response {
                    status_class: ash_http_client::HttpStatusClass::Success,
                } => Outcome::Succeeded,
                _ => Outcome::Failed,
            },
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
