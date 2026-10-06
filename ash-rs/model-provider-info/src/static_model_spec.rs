use ash_protocol::CapabilitySupport;
use ash_protocol::ContextWindow;
use ash_protocol::Model;
use ash_protocol::ModelCapabilities;
use ash_protocol::ModelId;
use ash_protocol::ModelInputModality;
use ash_protocol::ModelReasoningSummary;
use ash_protocol::ModelRef;
use ash_protocol::ModelServiceTier;
use ash_protocol::ModelSettings;
use ash_protocol::ModelToolOutputLimit;
use ash_protocol::ModelVerbosity;
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
    #[serde(default, deserialize_with = "ModelSettingsDeclaration::deserialize")]
    pub settings: ModelSettings,
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
        tools: Option<bool>,
        reasoning: Option<bool>,
        parallel_tool_calls: Option<bool>,
        image_detail_original: Option<bool>,
        fast_mode: Option<bool>,
    }
    let declaration = Declaration::deserialize(deserializer)?;
    Ok(ModelCapabilities {
        tools: capability_support(declaration.tools),
        reasoning: capability_support(declaration.reasoning),
        parallel_tool_calls: capability_support(declaration.parallel_tool_calls),
        image_detail_original: capability_support(declaration.image_detail_original),
        fast_mode: capability_support(declaration.fast_mode),
        personality: CapabilitySupport::Unknown,
    })
}

// Only the editable catalog uses nullable booleans. Remote derive constructs the shared settings
// type directly; its defaults and validation remain owned by the protocol contract.
#[derive(Deserialize)]
#[serde(
    remote = "ModelSettings",
    rename_all = "camelCase",
    default = "ModelSettings::default",
    deny_unknown_fields
)]
struct ModelSettingsDeclaration {
    input_modalities: Option<Vec<ModelInputModality>>,
    #[serde(deserialize_with = "deserialize_capability_support")]
    verbosity: CapabilitySupport,
    default_verbosity: Option<ModelVerbosity>,
    #[serde(deserialize_with = "deserialize_capability_support")]
    reasoning_summary: CapabilitySupport,
    default_reasoning_summary: Option<ModelReasoningSummary>,
    service_tiers: Option<Vec<ModelServiceTier>>,
    default_service_tier: Option<ModelServiceTier>,
    tool_output_limit: Option<ModelToolOutputLimit>,
}

fn deserialize_capability_support<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<CapabilitySupport, D::Error> {
    Ok(capability_support(Option::<bool>::deserialize(
        deserializer,
    )?))
}

fn capability_support(value: Option<bool>) -> CapabilitySupport {
    match value {
        Some(true) => CapabilitySupport::Supported,
        Some(false) => CapabilitySupport::Unsupported,
        None => CapabilitySupport::Unknown,
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
