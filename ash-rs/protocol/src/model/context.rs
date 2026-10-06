//! Read-only context inspection and allocation results computed by Core.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

use crate::ModelContextUsage;

/// Read-only local estimate of the currently loaded context. Category counts share one estimator;
/// a provider's latest-request measurement is separate and is never apportioned across categories.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelContextInspection {
    pub compaction_policy: crate::ContextCompactionPolicy,
    pub model: Option<crate::ModelRef>,
    #[ts(type = "number")]
    pub estimated_tokens: u64,
    pub estimator_revision: String,
    pub categories: Vec<ModelContextCategoryUsage>,
    pub allocation: Option<ModelContextAllocation>,
    pub latest_request: Option<ModelContextUsage>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ModelContextCategory {
    SystemPrompt,
    SystemTools,
    MemoryFiles,
    Skills,
    Conversation,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelContextCategoryUsage {
    pub category: ModelContextCategory,
    #[ts(type = "number")]
    pub tokens: u64,
    pub sources: Vec<ModelContextSourceUsage>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelContextSourceUsage {
    pub name: String,
    /// Catalog entry count, including metadata omitted by the prompt byte limit.
    /// Individual instruction and tool sources have no catalog count.
    #[ts(type = "number | null")]
    pub item_count: Option<u64>,
    #[ts(type = "number")]
    pub tokens: u64,
}

/// Allocations come from the execution budget, including any model-specific calibration.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelContextAllocation {
    #[ts(type = "number")]
    pub context_window: u64,
    #[ts(type = "number")]
    pub auto_compact_window: u64,
    #[ts(type = "number")]
    pub auto_compact_at: u64,
    #[ts(type = "number")]
    pub auto_compact_buffer: u64,
    #[ts(type = "number")]
    pub reserved_output: u64,
    #[ts(type = "number")]
    pub safety_margin: u64,
}
