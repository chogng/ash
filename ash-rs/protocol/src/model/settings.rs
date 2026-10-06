use crate::CapabilitySupport;
use crate::ModelId;
use crate::ModelSpeed;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ModelInputModality {
    Text,
    Image,
    Audio,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ModelVerbosity {
    Low,
    Medium,
    High,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ModelReasoningSummary {
    None,
    Auto,
    Concise,
    Detailed,
}

/// Limits model-visible tool text; original durable tool results remain intact.
/// Token limits use the shared output utility's UTF-8 byte approximation, not token measurement.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "mode", content = "limit", rename_all = "camelCase")]
pub enum ModelToolOutputLimit {
    Bytes(u32),
    Tokens(u32),
}

/// A provider service tier ID is a request value; its label and explanation are display metadata.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelServiceTier {
    pub id: String,
    pub name: String,
    pub description: String,
}

/// The model catalog owns how the product's acceleration preference changes a call.
/// A speed parameter and a different model ID must never be recorded as service tiers.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ModelAcceleration {
    #[serde(rename_all = "camelCase")]
    ServiceTier { service_tier: String },
    Speed {
        speed: ModelSpeed,
        name: String,
        description: String,
    },
    Model {
        model: ModelId,
        name: String,
        description: String,
    },
}

/// Request settings frozen with the same model snapshot as its capacity.
/// Missing lists/defaults and Unknown capabilities are absence of evidence, not restrictions.
/// Endpoint support and user choices are checked separately by the invocation owner.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ModelSettings {
    pub input_modalities: Option<Vec<ModelInputModality>>,
    pub verbosity: CapabilitySupport,
    pub default_verbosity: Option<ModelVerbosity>,
    pub reasoning_summary: CapabilitySupport,
    pub default_reasoning_summary: Option<ModelReasoningSummary>,
    pub service_tiers: Option<Vec<ModelServiceTier>>,
    pub default_service_tier: Option<String>,
    pub acceleration: Option<ModelAcceleration>,
    pub tool_output_limit: Option<ModelToolOutputLimit>,
}

impl Default for ModelSettings {
    fn default() -> Self {
        Self {
            input_modalities: None,
            verbosity: CapabilitySupport::Unknown,
            default_verbosity: None,
            reasoning_summary: CapabilitySupport::Unknown,
            default_reasoning_summary: None,
            service_tiers: None,
            default_service_tier: None,
            acceleration: None,
            tool_output_limit: None,
        }
    }
}

impl ModelSettings {
    /// Validates declarations at JSON, discovery, or persistence boundaries.
    pub fn validate(&self) -> Result<(), &'static str> {
        if let Some(modalities) = &self.input_modalities
            && (modalities.is_empty()
                || !modalities.contains(&ModelInputModality::Text)
                || modalities
                    .iter()
                    .enumerate()
                    .any(|(i, item)| modalities[..i].contains(item)))
        {
            return Err("text model input modalities must contain text and be unique");
        }
        if self.default_verbosity.is_some() && self.verbosity != CapabilitySupport::Supported {
            return Err("default verbosity requires declared support");
        }
        if self.default_reasoning_summary.is_some()
            && self.reasoning_summary != CapabilitySupport::Supported
        {
            return Err("default reasoning summary requires declared parameter support");
        }
        if let Some(tiers) = &self.service_tiers {
            if tiers.is_empty()
                || tiers.iter().any(|tier| {
                    tier.id.trim().is_empty()
                        || tier.name.trim().is_empty()
                        || tier.description.trim().is_empty()
                })
                || tiers
                    .iter()
                    .enumerate()
                    .any(|(i, tier)| tiers[..i].iter().any(|other| other.id == tier.id))
            {
                return Err("service tiers require unique IDs and non-empty display metadata");
            }
        }
        for tier in self
            .default_service_tier
            .iter()
            .chain(match &self.acceleration {
                Some(ModelAcceleration::ServiceTier { service_tier }) => Some(service_tier),
                _ => None,
            })
        {
            if !self
                .service_tiers
                .as_ref()
                .is_some_and(|tiers| tiers.iter().any(|entry| &entry.id == tier))
            {
                return Err("default and acceleration service tiers must reference declared IDs");
            }
        }
        if let Some(
            ModelAcceleration::Speed {
                name, description, ..
            }
            | ModelAcceleration::Model {
                name, description, ..
            },
        ) = &self.acceleration
            && (name.trim().is_empty() || description.trim().is_empty())
        {
            return Err("acceleration requires non-empty display metadata");
        }
        if matches!(
            self.tool_output_limit,
            Some(ModelToolOutputLimit::Bytes(0) | ModelToolOutputLimit::Tokens(0))
        ) {
            return Err("tool output limit must be positive");
        }
        Ok(())
    }
}
