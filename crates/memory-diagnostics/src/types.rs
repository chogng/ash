use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MemoryProduct {
    Tui,
    RustGui,
    Electron,
    Browser,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryStart {
    #[schemars(length(min = 1, max = 128))]
    pub request_id: String,
    pub product: MemoryProduct,
    #[schemars(range(min = 10, max = 1800))]
    pub duration_secs: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MemoryRole {
    Backend,
    Tool,
    Tui,
    RustGui,
    ElectronMain,
    Renderer,
    Gpu,
    Utility,
    Extension,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MemoryOrigin {
    BackendHost,
    ClientHost,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MemoryPhase {
    Busy,
    Idle,
    Unknown,
}

#[derive(
    Clone, Copy, Debug, Deserialize, Eq, JsonSchema, Ord, PartialEq, PartialOrd, Serialize, TS,
)]
#[serde(rename_all = "camelCase")]
pub enum MemoryMetricKind {
    ResidentBytes,
    JavaScriptHeapBytes,
    DomNodes,
    EventListeners,
    UiObjects,
    Windows,
    CacheBytes,
    GpuEstimatedBytes,
    GpuResources,
    RenderCacheEntries,
    Tasks,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MemoryUnavailable {
    Unsupported,
    PermissionDenied,
    ReadFailed,
    Exited,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryMetric {
    pub kind: MemoryMetricKind,
    #[ts(type = "number | null")]
    pub value: Option<u64>,
    pub unavailable: Option<MemoryUnavailable>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryObservation {
    #[schemars(length(min = 1, max = 128))]
    pub instance_id: String,
    pub process_id: Option<u32>,
    pub role: MemoryRole,
    pub phase: MemoryPhase,
    #[schemars(length(min = 1, max = 11))]
    pub metrics: Vec<MemoryMetric>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryEvidence {
    #[schemars(length(min = 1, max = 128))]
    pub session_id: String,
    #[ts(type = "number")]
    pub sequence: u64,
    #[schemars(length(min = 1, max = 32))]
    pub observations: Vec<MemoryObservation>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MemoryStatus {
    Recording,
    Stopped,
    BudgetExpired,
    TargetsExited,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MemoryFinding {
    InsufficientEvidence,
    NoSustainedGrowthObserved,
    SustainedGrowth,
    IdleBaselineGrowth,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryTrend {
    pub kind: MemoryMetricKind,
    pub finding: MemoryFinding,
    pub samples: u32,
    pub span_secs: f64,
    pub growth_per_second: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemorySample {
    #[ts(type = "number")]
    pub elapsed_ms: u64,
    pub phase: MemoryPhase,
    pub metrics: Vec<MemoryMetric>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryTargetReport {
    pub origin: MemoryOrigin,
    pub instance_id: String,
    pub process_id: Option<u32>,
    pub role: MemoryRole,
    pub samples: u32,
    pub discarded_samples: u32,
    pub latest: MemorySample,
    pub trends: Vec<MemoryTrend>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReport {
    pub version: u32,
    pub session_id: String,
    pub product: MemoryProduct,
    pub status: MemoryStatus,
    #[ts(type = "number")]
    pub started_at_ms: u64,
    #[ts(type = "number")]
    pub elapsed_ms: u64,
    pub sample_interval_ms: u32,
    pub targets: Vec<MemoryTargetReport>,
    pub evidence_gaps: u32,
}
