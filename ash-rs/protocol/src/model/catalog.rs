use crate::Personality;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use std::fmt;
use ts_rs::TS;

macro_rules! model_identifier {
    ($name:ident, $label:literal) => {
        #[derive(Clone, Debug, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize, TS)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, InvalidModelIdentity> {
                let value = value.into();
                if value.trim().is_empty() {
                    return Err(InvalidModelIdentity(
                        concat!($label, " must not be empty").into(),
                    ));
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
            }
        }
    };
}

model_identifier!(ProviderId, "provider ID");
model_identifier!(ModelId, "model ID");
model_identifier!(ModelConnectionId, "model connection ID");

#[derive(Clone, Debug, Deserialize, Eq, Hash, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    pub provider: ProviderId,
    pub model: ModelId,
}

impl ModelRef {
    pub fn new(provider: ProviderId, model: ModelId) -> Self {
        Self { provider, model }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    ExtraHigh,
    Max,
}

impl ReasoningEffort {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::ExtraHigh => "xhigh",
            Self::Max => "max",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "none" => Some(Self::None),
            "minimal" => Some(Self::Minimal),
            "low" => Some(Self::Low),
            "medium" | "med" => Some(Self::Medium),
            "high" => Some(Self::High),
            "extrahigh" | "extra-high" | "extra_high" | "xhigh" => Some(Self::ExtraHigh),
            "max" => Some(Self::Max),
            _ => None,
        }
    }
}

impl fmt::Display for ReasoningEffort {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A selectable effort and its catalog explanation. Missing copy is unknown metadata;
/// the effort remains a request value and never implies a fixed token budget.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelReasoningEffortOption {
    pub effort: ReasoningEffort,
    pub description: Option<String>,
}

impl From<ReasoningEffort> for ModelReasoningEffortOption {
    fn from(effort: ReasoningEffort) -> Self {
        Self {
            effort,
            description: None,
        }
    }
}

impl std::str::FromStr for ReasoningEffort {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value).ok_or_else(|| {
            format!("unknown reasoning effort '{value}'; valid choices: none, minimal, low, medium, high, xhigh, max")
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CapabilitySupport {
    Supported,
    Unsupported,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ContextWindow {
    Known(u32),
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ModelAvailability {
    Available,
    Unavailable,
    Unverified,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ModelCatalogFreshness {
    Fresh,
    StaleUsable,
    Expired,
    StaticOnly,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ModelLifecycle {
    Stable,
    Preview,
    Legacy,
    Retired,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ModelMetadataQuality {
    ProviderLive,
    UserConfigured,
    BuiltinCurated,
    ProviderSeed,
    PersistedObservation,
    Unknown,
}

/// How a user gains access to a model.
///
/// [`ModelRef::provider`] identifies the model vendor. Product composition may use this access
/// mode to choose an execution backend, but it is not proof of authentication, entitlement, or
/// remote availability.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ModelAccess {
    ApiKey,
    Subscription,
    Local,
    Enterprise,
    #[default]
    Unknown,
}

/// How one configured model runtime obtains completion output from its provider endpoint.
///
/// This describes the immutable adapter path, not whether a remote request is entitled or will
/// succeed. Unary runtimes return the completed result without synthesizing incremental deltas.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ModelOutputTransport {
    NativeStreaming,
    #[default]
    Unary,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilities {
    pub tools: CapabilitySupport,
    pub reasoning: CapabilitySupport,
    pub parallel_tool_calls: CapabilitySupport,
    pub personality: CapabilitySupport,
    #[serde(default = "unknown_capability_support")]
    pub image_detail_original: CapabilitySupport,
    #[serde(default = "unknown_capability_support")]
    pub fast_mode: CapabilitySupport,
}

impl ModelCapabilities {
    pub const UNKNOWN: Self = Self {
        tools: CapabilitySupport::Unknown,
        reasoning: CapabilitySupport::Unknown,
        parallel_tool_calls: CapabilitySupport::Unknown,
        personality: CapabilitySupport::Unknown,
        image_detail_original: CapabilitySupport::Unknown,
        fast_mode: CapabilitySupport::Unknown,
    };
}

fn unknown_capability_support() -> CapabilitySupport {
    CapabilitySupport::Unknown
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: ModelId,
    pub display_name: String,
    pub description: Option<String>,
    #[serde(default)]
    pub access: ModelAccess,
    pub context_window: ContextWindow,
    pub auto_compact_token_limit: Option<u32>,
    pub capabilities: ModelCapabilities,
    pub supported_reasoning_efforts: Vec<ModelReasoningEffortOption>,
    pub model_reasoning_effort: Option<ReasoningEffort>,
    pub default_personality: Option<Personality>,
    #[serde(default)]
    pub settings: crate::ModelSettings,
}

impl ModelInfo {
    /// Validates catalog copy before a static, discovered, or persisted row is published.
    pub fn validate_presentation(
        description: Option<&str>,
        efforts: &[ModelReasoningEffortOption],
    ) -> Result<(), String> {
        if description.is_some_and(|copy| copy.trim().is_empty()) {
            return Err("model description must not be blank".into());
        }
        let mut seen = std::collections::BTreeSet::new();
        for option in efforts {
            if !seen.insert(option.effort.as_str()) {
                return Err(format!("duplicate reasoning effort '{}'", option.effort));
            }
            if option
                .description
                .as_ref()
                .is_some_and(|copy| copy.trim().is_empty())
            {
                return Err(format!(
                    "reasoning effort '{}' description must not be blank",
                    option.effort
                ));
            }
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<(), String> {
        Self::validate_presentation(
            self.description.as_deref(),
            &self.supported_reasoning_efforts,
        )?;
        self.settings.validate().map_err(str::to_owned)
    }

    pub fn new(id: ModelId, display_name: impl Into<String>) -> Self {
        Self {
            id,
            display_name: display_name.into(),
            description: None,
            access: ModelAccess::Unknown,
            context_window: ContextWindow::Unknown,
            auto_compact_token_limit: None,
            capabilities: ModelCapabilities::UNKNOWN,
            supported_reasoning_efforts: Vec::new(),
            model_reasoning_effort: None,
            default_personality: None,
            settings: crate::ModelSettings::default(),
        }
    }
}

pub type Model = ModelInfo;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelPreset {
    pub id: String,
    pub name: String,
    pub model: ModelRef,
    pub model_reasoning_effort: Option<ReasoningEffort>,
    pub personality: Option<Personality>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvalidModelIdentity(pub String);

impl fmt::Display for InvalidModelIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for InvalidModelIdentity {}
