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

/// Selects whether this read includes internal definitions for explicit developer inspection.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ContextReadDetail {
    Usage,
    Diagnostics,
}

/// Inspect loaded context without starting a Turn or invoking a model.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContextReadParams {
    pub scope: ContextReadScope,
    pub detail: ContextReadDetail,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContextReadResult {
    pub context: ash_protocol::ModelContextInspection,
    /// Populated only for diagnostics; definitions and counts come from the same catalog sample.
    pub tool_definitions: Vec<ContextToolDefinition>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContextToolDefinition {
    pub name: String,
    pub description: String,
    #[ts(type = "unknown")]
    pub parameters: serde_json::Value,
    pub strict: bool,
    #[ts(type = "number")]
    pub tokens: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub struct ModelCatalogEntry {
    pub model: ModelRef,
    pub display_name: String,
    pub description: Option<String>,
    /// True only when this ID belongs to the last successful endpoint observation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub discovered: Option<bool>,
    pub context_window: Option<u32>,
    /// Context budget without a per-model preference, distinct from the effective budget and ceiling.
    pub default_context_window: Option<u32>,
    /// Long context selection on the active connection; null means no larger budget is available.
    pub long_context: Option<bool>,
    /// Current preference on the active connection; capability support is reported separately.
    pub selected_acceleration: Option<String>,
    /// Effective choices after connection restrictions and per-option denials.
    pub acceleration_options: Vec<ash_protocol::ModelAccelerationOption>,
    /// Model or custom connection ceiling before applying its context budget preference.
    pub maximum_context_window: Option<u32>,
    pub auto_compact_token_limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub available_context_window: Option<u32>,
    pub capabilities: ModelCapabilities,
    pub supported_reasoning_efforts: Vec<ash_protocol::ModelReasoningEffortOption>,
    /// Catalog default, used when no reasoning effort is selected for the invocation.
    pub default_reasoning_effort: Option<ReasoningEffort>,
    pub default_personality: Option<Personality>,
    #[serde(default)]
    pub settings: ash_protocol::ModelSettings,
}

impl ModelCatalogEntry {
    /// Projects provider-neutral model metadata into the public App Server catalog DTO.
    pub fn from_info(model: ModelRef, info: &ModelInfo) -> Self {
        debug_assert_eq!(model.model, info.id);
        Self {
            model,
            display_name: info.display_name.clone(),
            description: info.description.clone(),
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
            long_context: None,
            selected_acceleration: None,
            acceleration_options: if info.capabilities.fast_mode
                == ash_protocol::CapabilitySupport::Unsupported
            {
                Vec::new()
            } else {
                info.settings.acceleration_options()
            },
            auto_compact_token_limit: info.auto_compact_token_limit,
            available_context_window: None,
            capabilities: info.capabilities,
            supported_reasoning_efforts: info.supported_reasoning_efforts.clone(),
            default_reasoning_effort: info.default_reasoning_effort,
            default_personality: info.default_personality,
            settings: info.settings.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ModelListParams {}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ModelPreferencesUpdateParams {
    pub command_id: ash_protocol::CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub model: ModelRef,
    #[serde(default, skip_serializing_if = "ash_protocol::Patch::is_missing")]
    #[schemars(with = "Option<String>")]
    #[ts(as = "Option<String>", optional = nullable)]
    pub acceleration: ash_protocol::Patch<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub long_context: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub struct ModelListResult {
    pub models: Vec<ModelCatalogEntry>,
}

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;
