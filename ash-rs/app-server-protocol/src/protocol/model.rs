use crate::JsonSchema;
use crate::TS;
use ash_protocol::ContextWindow;
use ash_protocol::ModelCapabilities;
use ash_protocol::ModelInfo;
use ash_protocol::ModelRef;
use ash_protocol::Personality;
use ash_protocol::ReasoningEffort;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ContextReadScope {
    Environment,
    Thread {
        session_id: ash_protocol::SessionId,
        thread_id: ash_protocol::ThreadId,
    },
}

/// Inspect loaded context without starting a Turn or invoking a model.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContextReadParams {
    pub scope: ContextReadScope,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContextReadResult {
    pub context: ash_protocol::ModelContextInspection,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogEntry {
    pub model: ModelRef,
    pub display_name: String,
    /// True only when this ID belongs to the last successful endpoint observation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub discovered: Option<bool>,
    pub context_window: Option<u32>,
    /// Context budget without a per-model preference, distinct from the effective budget and ceiling.
    pub default_context_window: Option<u32>,
    /// Selectable budgets in ascending order: empty for unknown, one for fixed capacity,
    /// or two for a compact/expanded switch. Clients must not infer choices from the ceiling.
    pub context_window_options: Vec<u32>,
    /// Current preference on the active connection; capability support is reported separately.
    pub fast_enabled: bool,
    /// Model or custom connection ceiling before applying its context budget preference.
    pub maximum_context_window: Option<u32>,
    pub auto_compact_token_limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub available_context_window: Option<u32>,
    pub capabilities: ModelCapabilities,
    pub supported_reasoning_efforts: Vec<ReasoningEffort>,
    pub model_reasoning_effort: Option<ReasoningEffort>,
    pub default_personality: Option<Personality>,
}

impl ModelCatalogEntry {
    /// Projects provider-neutral model metadata into the public App Server catalog DTO.
    pub fn from_info(model: ModelRef, info: &ModelInfo) -> Self {
        debug_assert_eq!(model.model, info.id);
        Self {
            model,
            display_name: info.display_name.clone(),
            discovered: None,
            context_window: match info.context_window {
                ContextWindow::Known(tokens) => Some(tokens),
                ContextWindow::Unknown => None,
            },
            maximum_context_window: match info.context_window {
                ContextWindow::Known(tokens) => Some(tokens),
                ContextWindow::Unknown => None,
            },
            default_context_window: match info.context_window {
                ContextWindow::Known(tokens) => Some(tokens),
                ContextWindow::Unknown => None,
            },
            context_window_options: match info.context_window {
                ContextWindow::Known(tokens) => vec![tokens],
                ContextWindow::Unknown => Vec::new(),
            },
            fast_enabled: false,
            auto_compact_token_limit: info.auto_compact_token_limit,
            available_context_window: None,
            capabilities: info.capabilities,
            supported_reasoning_efforts: info.supported_reasoning_efforts.clone(),
            model_reasoning_effort: info.model_reasoning_effort,
            default_personality: info.default_personality,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelListParams {}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelPreferencesUpdateParams {
    pub command_id: ash_protocol::CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub model: ModelRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub fast: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub context_window: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelListResult {
    pub models: Vec<ModelCatalogEntry>,
}

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;
