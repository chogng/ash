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
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogEntry {
    pub model: ModelRef,
    pub display_name: String,
    /// True only when this ID belongs to the last successful endpoint observation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub discovered: Option<bool>,
    pub context_window: Option<u32>,
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
#[serde(rename_all = "camelCase")]
pub struct ModelListResult {
    pub models: Vec<ModelCatalogEntry>,
}

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;
