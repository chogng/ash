use crate::JsonSchema;
use crate::TS;
use ash_protocol::ContextWindow;
use ash_protocol::ModelAccess;
use ash_protocol::ModelCapabilities;
use ash_protocol::ModelInfo;
use ash_protocol::ModelOutputTransport;
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
    pub access: ModelAccess,
    pub output_transport: ModelOutputTransport,
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
    pub fn from_info(
        model: ModelRef,
        info: &ModelInfo,
        output_transport: ModelOutputTransport,
    ) -> Self {
        debug_assert_eq!(model.model, info.id);
        Self {
            model,
            display_name: info.display_name.clone(),
            access: info.access,
            output_transport,
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

/// Selects the product's fixed catalog or the account-scoped observed catalog.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ModelListView {
    BuiltIn,
    Discovered,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelListParams {
    pub view: ModelListView,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelListResult {
    pub models: Vec<ModelCatalogEntry>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use ash_protocol::CapabilitySupport;
    use ash_protocol::ModelId;
    use ash_protocol::ProviderId;

    #[test]
    fn model_list_requires_an_explicit_view() {
        assert_eq!(
            serde_json::to_value(ModelListParams {
                view: ModelListView::BuiltIn,
            })
            .unwrap(),
            serde_json::json!({"view":"builtIn"})
        );
        assert_eq!(
            serde_json::from_value::<ModelListParams>(serde_json::json!({"view":"discovered"}))
                .unwrap()
                .view,
            ModelListView::Discovered
        );
        assert!(serde_json::from_value::<ModelListParams>(serde_json::json!({})).is_err());
    }

    #[test]
    fn catalog_entry_projects_all_public_static_metadata() {
        let model = ModelRef::new(
            ProviderId::new("test-provider").unwrap(),
            ModelId::new("test-model").unwrap(),
        );
        let mut info = ModelInfo::new(model.model.clone(), "Test Model");
        info.access = ModelAccess::Subscription;
        info.context_window = ContextWindow::Known(1_000_000);
        info.auto_compact_token_limit = Some(900_000);
        info.capabilities.reasoning = CapabilitySupport::Supported;
        info.supported_reasoning_efforts = vec![ReasoningEffort::Medium, ReasoningEffort::High];
        info.model_reasoning_effort = Some(ReasoningEffort::High);
        info.default_personality = Some(Personality::Pragmatic);

        let entry = ModelCatalogEntry::from_info(
            model.clone(),
            &info,
            ModelOutputTransport::NativeStreaming,
        );

        assert_eq!(entry.model, model);
        assert_eq!(entry.display_name, "Test Model");
        assert_eq!(entry.access, ModelAccess::Subscription);
        assert_eq!(
            entry.output_transport,
            ModelOutputTransport::NativeStreaming
        );
        assert_eq!(entry.context_window, Some(1_000_000));
        assert_eq!(entry.auto_compact_token_limit, Some(900_000));
        assert_eq!(entry.available_context_window, None);
        assert_eq!(entry.capabilities.reasoning, CapabilitySupport::Supported);
        assert_eq!(
            entry.supported_reasoning_efforts,
            vec![ReasoningEffort::Medium, ReasoningEffort::High]
        );
        assert_eq!(entry.model_reasoning_effort, Some(ReasoningEffort::High));
        assert_eq!(entry.default_personality, Some(Personality::Pragmatic));
    }
}
