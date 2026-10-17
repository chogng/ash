//! Instance-owned cumulative OTel metrics. The SDK owns aggregation; snapshots only read it.

use opentelemetry::KeyValue;
use opentelemetry::metrics::Counter;
use opentelemetry::metrics::Histogram;
use opentelemetry::metrics::MeterProvider;
use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::metrics::InstrumentKind;
use opentelemetry_sdk::metrics::ManualReader;
use opentelemetry_sdk::metrics::Pipeline;
use opentelemetry_sdk::metrics::SdkMeterProvider;
use opentelemetry_sdk::metrics::Stream;
use opentelemetry_sdk::metrics::Temporality;
use opentelemetry_sdk::metrics::data::AggregatedMetrics;
use opentelemetry_sdk::metrics::data::MetricData;
use opentelemetry_sdk::metrics::data::ResourceMetrics;
use opentelemetry_sdk::metrics::reader::MetricReader;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Weak;
use std::time::Duration;
use std::time::Instant;
use ts_rs::TS;

const HISTOGRAM_BOUNDS: &[f64] = &[
    0., 1., 5., 10., 25., 50., 100., 250., 500., 1_000., 2_500., 5_000., 10_000., 30_000., 60_000.,
    180_000., 600_000., 1_000_000.,
];

/// Closed instrument names prevent untrusted input from creating new instruments.
#[derive(Clone, Copy, Debug)]
pub enum MetricOperation {
    McpCall,
    SkillActivation,
    GuardianReview,
    WindowsSandboxSetup,
    WindowsSandboxUpdate,
    WindowsSandboxRemove,
}

impl MetricOperation {
    fn name(self) -> &'static str {
        match self {
            Self::McpCall => "ash.mcp.call",
            Self::SkillActivation => "ash.skill.activation",
            Self::GuardianReview => "ash.guardian.review",
            Self::WindowsSandboxSetup => "ash.windows_sandbox.setup",
            Self::WindowsSandboxUpdate => "ash.windows_sandbox.update",
            Self::WindowsSandboxRemove => "ash.windows_sandbox.remove",
        }
    }
}

/// Terminal business outcomes keep review decisions distinct from execution failures.
#[derive(Clone, Copy, Debug)]
pub enum MetricOutcome {
    Succeeded,
    Failed,
    Cancelled,
    Denied,
    AskUser,
    ReviseAction,
}
impl MetricOutcome {
    fn label(self) -> &'static str {
        match self {
            Self::Succeeded => "ok",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Denied => "denied",
            Self::AskUser => "ask_user",
            Self::ReviseAction => "revise_action",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MetricKind {
    Counter,
    Histogram,
}

/// Counts for disjoint buckets, with one final bucket above the last bound.
/// All bounds are integers because this meter records whole milliseconds and token counts.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MetricDistribution {
    #[ts(type = "number[]")]
    pub bounds: Vec<u64>,
    #[ts(type = "number[]")]
    pub bucket_counts: Vec<u64>,
    #[ts(type = "number | null")]
    pub min: Option<u64>,
    #[ts(type = "number | null")]
    pub max: Option<u64>,
}

/// One cumulative SDK time series. Histogram count/total describe milliseconds or tokens;
/// counter count and total both hold the cumulative counter value. Tags are local metadata.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MetricSeries {
    pub name: String,
    pub tags: BTreeMap<String, String>,
    #[ts(type = "number")]
    pub count: u64,
    #[ts(type = "number")]
    pub total: u64,
    pub kind: MetricKind,
    pub distribution: Option<MetricDistribution>,
}

/// An instance-owned production meter. Clones share aggregation and release it together.
#[derive(Clone, Debug)]
pub struct Metrics(Arc<Inner>);

#[derive(Debug)]
struct Inner {
    provider: SdkMeterProvider,
    reader: Arc<ManualReader>,
}

impl Default for Metrics {
    fn default() -> Self {
        let reader = Arc::new(
            ManualReader::builder()
                .with_temporality(Temporality::Cumulative)
                .build(),
        );
        let provider = SdkMeterProvider::builder()
            .with_reader(SharedReader(reader.clone()))
            // Overflow measurements retain totals without retaining unbounded dynamic names.
            .with_view(|_| Stream::builder().with_cardinality_limit(128).build().ok())
            .build();
        Self(Arc::new(Inner { provider, reader }))
    }
}

impl Metrics {
    /// Starts a movable operation timer; no thread-local span guard crosses async waits.
    /// Only metadata chosen by the domain belongs in tags, never paths or error bodies.
    pub fn start(&self, operation: MetricOperation, tags: &[(&'static str, &str)]) -> MetricTimer {
        let meter = self.0.provider.meter("ash");
        let name = operation.name();
        MetricTimer {
            _metrics: self.clone(),
            count: meter.u64_counter(name).build(),
            errors: meter.u64_counter(format!("{name}.error")).build(),
            duration: meter
                .u64_histogram(format!("{name}.duration_ms"))
                .with_boundaries(HISTOGRAM_BOUNDS.to_vec())
                .with_unit("ms")
                .build(),
            tags: tags
                .iter()
                .map(|(key, value)| {
                    KeyValue::new(*key, ash_utils_string::sanitize_metric_tag_value(value))
                })
                .collect(),
            started: Instant::now(),
            status: MetricOutcome::Failed,
            error: None,
        }
    }

    /// Records provider-reported usage only; missing token information stays absent.
    pub fn guardian_tokens(
        &self,
        tags: &[(&'static str, &str)],
        token_type: &'static str,
        tokens: u64,
    ) {
        let mut tags: Vec<_> = tags
            .iter()
            .map(|(key, value)| {
                KeyValue::new(*key, ash_utils_string::sanitize_metric_tag_value(value))
            })
            .collect();
        tags.push(KeyValue::new("token_type", token_type));
        self.0
            .provider
            .meter("ash")
            .u64_histogram("ash.guardian.review.tokens")
            .with_boundaries(HISTOGRAM_BOUNDS.to_vec())
            .with_unit("{token}")
            .build()
            .record(tokens, &tags);
    }

    /// Records the first actual nonempty model delta; unary completions have no TTFT sample.
    pub fn guardian_first_token(&self, tags: &[(&'static str, &str)], elapsed: Duration) {
        let tags: Vec<_> = tags
            .iter()
            .map(|(key, value)| {
                KeyValue::new(*key, ash_utils_string::sanitize_metric_tag_value(value))
            })
            .collect();
        self.0
            .provider
            .meter("ash")
            .u64_histogram("ash.guardian.review.ttft_ms")
            .with_boundaries(HISTOGRAM_BOUNDS.to_vec())
            .with_unit("ms")
            .build()
            .record(elapsed.as_millis().min(u64::MAX as u128) as u64, &tags);
    }

    /// Reads cumulative production measurements without resetting them or doing network I/O.
    pub fn snapshot(&self) -> Vec<MetricSeries> {
        let mut resource = ResourceMetrics::default();
        // The reader lives exactly as long as its provider; collection cannot race shutdown.
        if self.0.reader.collect(&mut resource).is_err() {
            return Vec::new();
        }
        let mut series = Vec::new();
        for scope in resource.scope_metrics() {
            for metric in scope.metrics() {
                let AggregatedMetrics::U64(data) = metric.data() else {
                    continue;
                };
                match data {
                    MetricData::Sum(sum) => {
                        for point in sum.data_points() {
                            series.push(MetricSeries {
                                name: metric.name().into(),
                                tags: labels(point.attributes()),
                                count: point.value(),
                                total: point.value(),
                                kind: MetricKind::Counter,
                                distribution: None,
                            });
                        }
                    }
                    MetricData::Histogram(histogram) => {
                        for point in histogram.data_points() {
                            series.push(MetricSeries {
                                name: metric.name().into(),
                                tags: labels(point.attributes()),
                                count: point.count(),
                                total: point.sum(),
                                kind: MetricKind::Histogram,
                                distribution: Some(MetricDistribution {
                                    bounds: point.bounds().map(|bound| bound as u64).collect(),
                                    bucket_counts: point.bucket_counts().collect(),
                                    min: point.min(),
                                    max: point.max(),
                                }),
                            });
                        }
                    }
                    MetricData::Gauge(_) | MetricData::ExponentialHistogram(_) => {}
                }
            }
        }
        series.sort_by(|a, b| (&a.name, &a.tags).cmp(&(&b.name, &b.tags)));
        series
    }
}

fn labels<'a>(attributes: impl Iterator<Item = &'a KeyValue>) -> BTreeMap<String, String> {
    attributes
        .map(|kv| (kv.key.to_string(), kv.value.as_str().into_owned()))
        .collect()
}

/// Records exactly one terminal result, including early returns and dropped async futures.
pub struct MetricTimer {
    _metrics: Metrics,
    count: Counter<u64>,
    errors: Counter<u64>,
    duration: Histogram<u64>,
    tags: Vec<KeyValue>,
    started: Instant,
    status: MetricOutcome,
    error: Option<&'static str>,
}

impl MetricTimer {
    pub fn finish(mut self, status: MetricOutcome, error: Option<&'static str>) {
        self.status = status;
        self.error = error;
    }
}

impl Drop for MetricTimer {
    fn drop(&mut self) {
        self.tags.push(KeyValue::new("status", self.status.label()));
        self.count.add(1, &self.tags);
        self.duration.record(
            self.started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            &self.tags,
        );
        if self.error.is_some()
            || matches!(
                self.status,
                MetricOutcome::Failed | MetricOutcome::Cancelled
            )
        {
            self.tags.push(KeyValue::new(
                "error_type",
                self.error.unwrap_or("abandoned"),
            ));
            self.errors.add(1, &self.tags);
        }
    }
}

#[derive(Debug)]
struct SharedReader(Arc<ManualReader>);

impl MetricReader for SharedReader {
    fn register_pipeline(&self, pipeline: Weak<Pipeline>) {
        self.0.register_pipeline(pipeline);
    }
    fn collect(&self, metrics: &mut ResourceMetrics) -> OTelSdkResult {
        self.0.collect(metrics)
    }
    fn force_flush(&self) -> OTelSdkResult {
        self.0.force_flush()
    }
    fn shutdown_with_timeout(&self, timeout: Duration) -> OTelSdkResult {
        self.0.shutdown_with_timeout(timeout)
    }
    fn temporality(&self, kind: InstrumentKind) -> Temporality {
        self.0.temporality(kind)
    }
}

#[cfg(test)]
#[path = "metrics_tests.rs"]
mod tests;
