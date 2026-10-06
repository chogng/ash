//! Provider usage, request estimates, and read-only accumulated totals.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    /// Total provider-accounted input tokens, including cache reads and cache writes.
    #[serde(default)]
    #[ts(type = "number | null")]
    pub input_tokens: Option<u64>,
    #[serde(default)]
    #[ts(type = "number | null")]
    pub output_tokens: Option<u64>,
    /// Input tokens read from a provider prompt cache.
    #[serde(default)]
    #[ts(type = "number | null")]
    pub cached_input_tokens: Option<u64>,
    /// Input tokens written to a provider prompt cache.
    #[serde(default)]
    #[ts(type = "number | null")]
    pub cache_write_input_tokens: Option<u64>,
    #[serde(default)]
    #[ts(type = "number | null")]
    pub reasoning_tokens: Option<u64>,
}

/// Invocation input estimate recorded beside provider usage for future budget calibration.
///
/// The estimate remains distinct from provider-reported usage: it describes the canonical request
/// before the call, while [`ModelUsage`] describes what the provider reported after the call.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelInputEstimate {
    #[ts(type = "number")]
    pub estimated_input_tokens: u64,
    pub estimator_revision: String,
    pub calibration_revision: String,
}

/// Latest model-visible context size retained for one Turn.
///
/// Provider-reported token counts are preferred. When a provider omits input or output usage,
/// Core may retain its deterministic request estimate so clients can distinguish an estimate from
/// an exact provider measurement.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelContextUsage {
    #[ts(type = "number")]
    pub used_tokens: u64,
    pub source: ModelContextUsageSource,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ModelContextUsageSource {
    ProviderReported,
    Estimated,
}

/// One aggregate token metric built only from values explicitly reported by providers.
///
/// `reported` remains useful as a lower bound when one or more invocations omitted this metric;
/// `complete` says whether the reported value is also the exact aggregate.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageTotal {
    #[ts(type = "number")]
    pub reported: u64,
    pub complete: bool,
}

impl Default for ModelUsageTotal {
    fn default() -> Self {
        Self {
            reported: 0,
            complete: true,
        }
    }
}

/// Provider-reported usage aggregated across every model response in a Thread or Turn.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageSummary {
    #[ts(type = "number")]
    pub model_invocations: u64,
    pub input_tokens: ModelUsageTotal,
    pub output_tokens: ModelUsageTotal,
    pub cached_input_tokens: ModelUsageTotal,
    #[serde(default)]
    pub cache_write_input_tokens: ModelUsageTotal,
    pub reasoning_tokens: ModelUsageTotal,
}
