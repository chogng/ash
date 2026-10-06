use ash_protocol::CapabilitySupport;
use ash_protocol::ContextWindow;
use ash_protocol::Model;
use ash_protocol::ModelAcceleration;
use ash_protocol::ModelCapabilities;
use ash_protocol::ModelId;
use ash_protocol::ModelInputModality;
use ash_protocol::ModelReasoningEffortOption;
use ash_protocol::ModelReasoningSummary;
use ash_protocol::ModelRef;
use ash_protocol::ModelServiceTier;
use ash_protocol::ModelSettings;
use ash_protocol::ModelToolOutputLimit;
use ash_protocol::ModelVerbosity;
use ash_protocol::ProviderId;
use ash_protocol::ReasoningEffort;
use schemars::JsonSchema;
use serde::Deserialize;

/// Complete base instructions owned by one model entry, independently editable and versioned.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModelInstructions {
    pub revision: String,
    pub body: String,
}

/// One row in Ash's bundled JSON model catalog, independent of account access.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StaticModelSpec {
    pub provider_id: String,
    pub model_id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub instructions: ModelInstructions,
    #[serde(
        default = "unknown_context_window",
        deserialize_with = "context_window"
    )]
    #[schemars(with = "Option<u32>", transform = remove_runtime_default)]
    pub context_window: ContextWindow,
    /// Normalized budgets: the first is the default. Omitted JSON presets use declared capacity.
    #[serde(default)]
    pub context_window_options: Vec<u32>,
    pub auto_compact_token_limit: Option<u32>,
    #[serde(
        default = "unknown_capabilities",
        deserialize_with = "model_capabilities"
    )]
    #[schemars(with = "ModelCapabilitiesDeclaration", transform = remove_runtime_default)]
    pub capabilities: ModelCapabilities,
    #[serde(default)]
    pub supported_reasoning_efforts: Vec<ModelReasoningEffortOption>,
    pub model_reasoning_effort: Option<ReasoningEffort>,
    #[serde(default, deserialize_with = "model_settings")]
    #[schemars(with = "ModelSettingsDeclaration", transform = remove_runtime_default)]
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
        model.description = self.description.clone();
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

// Serde defaults normalize omitted declarations to runtime metadata. They are not editable
// JSON values, so the catalog schema must not offer them as insertion defaults.
fn remove_runtime_default(schema: &mut schemars::Schema) {
    schema
        .as_object_mut()
        .expect("field schema is an object")
        .remove("default");
}

fn unknown_capabilities() -> ModelCapabilities {
    ModelCapabilities::UNKNOWN
}

// The editable catalog declares only known capabilities. Keep this format separate from the
// complete runtime/transport metadata so adding a protocol field never adds work to every row.
fn model_capabilities<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<ModelCapabilities, D::Error> {
    let declaration = ModelCapabilitiesDeclaration::deserialize(deserializer)?;
    Ok(ModelCapabilities {
        tools: capability_support(declaration.tools),
        reasoning: capability_support(declaration.reasoning),
        parallel_tool_calls: capability_support(declaration.parallel_tool_calls),
        image_detail_original: capability_support(declaration.image_detail_original),
        fast_mode: capability_support(declaration.fast_mode),
        personality: CapabilitySupport::Unknown,
    })
}

#[derive(Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelCapabilitiesDeclaration {
    tools: Option<bool>,
    reasoning: Option<bool>,
    parallel_tool_calls: Option<bool>,
    image_detail_original: Option<bool>,
    fast_mode: Option<bool>,
}

// These are the parsed editable fields, not a separate schema definition. JSON Schema derives
// from this declaration; protocol settings continue to own runtime defaults and validation.
#[derive(Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelSettingsDeclaration {
    input_modalities: Option<Vec<ModelInputModality>>,
    verbosity: Option<bool>,
    default_verbosity: Option<ModelVerbosity>,
    reasoning_summary: Option<bool>,
    default_reasoning_summary: Option<ModelReasoningSummary>,
    service_tiers: Option<Vec<ModelServiceTier>>,
    default_service_tier: Option<String>,
    acceleration: Option<ModelAcceleration>,
    tool_output_limit: Option<ModelToolOutputLimit>,
}

fn model_settings<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<ModelSettings, D::Error> {
    let declaration = ModelSettingsDeclaration::deserialize(deserializer)?;
    Ok(ModelSettings {
        input_modalities: declaration.input_modalities,
        verbosity: capability_support(declaration.verbosity),
        default_verbosity: declaration.default_verbosity,
        reasoning_summary: capability_support(declaration.reasoning_summary),
        default_reasoning_summary: declaration.default_reasoning_summary,
        service_tiers: declaration.service_tiers,
        default_service_tier: declaration.default_service_tier,
        acceleration: declaration.acceleration,
        tool_output_limit: declaration.tool_output_limit,
    })
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
