use ash_protocol::CapabilitySupport;
use ash_protocol::ContextWindow;
use ash_protocol::Model;
use ash_protocol::ModelCapabilities;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use ash_protocol::ReasoningEffort;
use serde::Deserialize;

/// Complete base instructions owned by one model entry, independently editable and versioned.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModelInstructions {
    pub revision: String,
    pub body: String,
}

/// One row in Ash's bundled JSON model catalog, independent of account access.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StaticModelSpec {
    pub provider_id: String,
    pub model_id: String,
    pub display_name: String,
    pub instructions: ModelInstructions,
    #[serde(
        default = "unknown_context_window",
        deserialize_with = "context_window"
    )]
    pub context_window: ContextWindow,
    /// Normalized budgets: the first is the default. Omitted JSON presets use declared capacity.
    #[serde(default)]
    pub context_window_options: Vec<u32>,
    pub auto_compact_token_limit: Option<u32>,
    #[serde(
        default = "unknown_capabilities",
        deserialize_with = "model_capabilities"
    )]
    pub capabilities: ModelCapabilities,
    #[serde(default)]
    pub supported_reasoning_efforts: Vec<ReasoningEffort>,
    pub model_reasoning_effort: Option<ReasoningEffort>,
    #[serde(default)]
    pub settings: ash_protocol::ModelSettings,
}

impl StaticModelSpec {
    /// Builds the runtime model identity represented by this validated row.
    pub fn model_ref(&self) -> ModelRef {
        ModelRef::new(
            ProviderId::new(&self.provider_id).expect("catalog provider ID is valid"),
            ModelId::new(&self.model_id).expect("catalog model ID is valid"),
        )
    }

    /// Builds provider-neutral metadata; a catalog entry grants no account access.
    pub fn model(&self) -> Model {
        let mut model = Model::new(
            ModelId::new(&self.model_id).expect("catalog model ID is valid"),
            &self.display_name,
        );
        model.context_window = self.context_window;
        model.auto_compact_token_limit = self.auto_compact_token_limit;
        model.capabilities = self.capabilities;
        model.supported_reasoning_efforts = self.supported_reasoning_efforts.clone();
        model.model_reasoning_effort = self.model_reasoning_effort;
        model.settings = self.settings.clone();
        model
    }
}

fn unknown_context_window() -> ContextWindow {
    ContextWindow::Unknown
}

fn unknown_capabilities() -> ModelCapabilities {
    ModelCapabilities::UNKNOWN
}

// The editable catalog declares only known capabilities. Keep this format separate from the
// complete runtime/transport metadata so adding a protocol field never adds work to every row.
fn model_capabilities<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<ModelCapabilities, D::Error> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Declaration {
        tools: Option<CapabilitySupport>,
        reasoning: Option<CapabilitySupport>,
        parallel_tool_calls: Option<CapabilitySupport>,
        image_detail_original: Option<CapabilitySupport>,
        fast_mode: Option<CapabilitySupport>,
    }
    let declaration = Declaration::deserialize(deserializer)?;
    Ok(ModelCapabilities {
        tools: declaration.tools.unwrap_or(CapabilitySupport::Unknown),
        reasoning: declaration.reasoning.unwrap_or(CapabilitySupport::Unknown),
        parallel_tool_calls: declaration
            .parallel_tool_calls
            .unwrap_or(CapabilitySupport::Unknown),
        image_detail_original: declaration
            .image_detail_original
            .unwrap_or(CapabilitySupport::Unknown),
        fast_mode: declaration.fast_mode.unwrap_or(CapabilitySupport::Unknown),
        personality: CapabilitySupport::Unknown,
    })
}

// JSON uses a token count or null; it never fabricates a size for unknown metadata.
fn context_window<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<ContextWindow, D::Error> {
    match Option::<u32>::deserialize(deserializer)? {
        Some(0) => Err(serde::de::Error::custom("context window must be positive")),
        Some(tokens) => Ok(ContextWindow::Known(tokens)),
        None => Ok(ContextWindow::Unknown),
    }
}

#[cfg(test)]
#[path = "static_model_spec_tests.rs"]
mod tests;
