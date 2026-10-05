use ash_protocol::ContextWindow;
use ash_protocol::Model;
use ash_protocol::ModelCapabilities;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;
use ash_protocol::Personality;
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
    #[serde(deserialize_with = "context_window")]
    pub context_window: ContextWindow,
    /// Execution budget before user overrides; context_window remains the model's capacity.
    #[serde(deserialize_with = "context_window")]
    pub default_context_window: ContextWindow,
    pub context_window_options: Vec<u32>,
    pub auto_compact_token_limit: Option<u32>,
    pub capabilities: ModelCapabilities,
    pub supported_reasoning_efforts: Vec<ReasoningEffort>,
    pub model_reasoning_effort: Option<ReasoningEffort>,
    pub default_personality: Option<Personality>,
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
        model.default_personality = self.default_personality;
        model
    }
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
