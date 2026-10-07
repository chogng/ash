//! Model specifications and observed availability; no invocation or selection algorithms.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

use crate::ModelId;
use crate::ModelReasoningEffortOption;
use crate::ModelRef;
use crate::Personality;
use crate::ReasoningEffort;

/// Evidence about support; `Unknown` means unverified, not unsupported.
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

/// A confirmed retirement announcement for the catalog's exact model and connection scope.
///
/// This is independent of lifecycle classification and availability: legacy or preview models
/// are not necessarily retiring, and an announcement does not revoke access or select a replacement.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ModelRetirement {
    /// Exact shutdown date in YYYY-MM-DD form; null means announced without a confirmed date.
    /// Earliest possible dates are not exact shutdown dates. Keep date-only values out of time zones.
    pub shutdown_date: Option<String>,
}

impl ModelRetirement {
    pub fn validate(&self) -> Result<(), String> {
        let Some(date) = self.shutdown_date.as_deref() else {
            return Ok(());
        };
        let bytes = date.as_bytes();
        if bytes.len() != 10
            || bytes[4] != b'-'
            || bytes[7] != b'-'
            || !bytes
                .iter()
                .enumerate()
                .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
        {
            return Err("retirement shutdown_date must be a YYYY-MM-DD date".into());
        }
        let year: u32 = date[..4].parse().expect("validated date digits");
        let month: u32 = date[5..7].parse().expect("validated date digits");
        let day: u32 = date[8..].parse().expect("validated date digits");
        let days = match month {
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            4 | 6 | 9 | 11 => 30,
            2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
            2 => 28,
            _ => 0,
        };
        if year == 0 || day == 0 || day > days {
            return Err("retirement shutdown_date must be a valid calendar date".into());
        }
        Ok(())
    }
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub struct ModelCapabilities {
    pub tools: CapabilitySupport,
    pub reasoning: CapabilitySupport,
    pub parallel_tool_calls: CapabilitySupport,
    pub personality: CapabilitySupport,
    #[serde(default = "unknown_capability_support")]
    pub image_detail_original: CapabilitySupport,
    /// Whether acceleration is supported; [`crate::ModelSettings::acceleration`] declares its mechanism.
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

/// Provider-neutral model metadata from bundled declarations or a connection-scoped observation.
///
/// Capacity and parameter declarations guide request construction; this row does not prove account
/// access or endpoint compatibility. The editable bundled row is owned by model-provider-info.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub struct ModelInfo {
    pub id: ModelId,
    pub display_name: String,
    pub description: Option<String>,
    #[serde(default)]
    pub access: ModelAccess,
    /// Connection-sourced retirement evidence; omission means no known announcement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub retirement: Option<ModelRetirement>,
    pub context_window: ContextWindow,
    /// Optional model-specific compaction threshold; Core determines the effective execution budget.
    pub auto_compact_token_limit: Option<u32>,
    pub capabilities: ModelCapabilities,
    /// Selectable request values with optional display explanations; not fixed token budgets.
    pub supported_reasoning_efforts: Vec<ModelReasoningEffortOption>,
    /// Catalog default when the user has not selected an effort; not the provider's implicit default.
    pub default_reasoning_effort: Option<ReasoningEffort>,
    pub default_personality: Option<Personality>,
    #[serde(default)]
    /// Supported parameters and Ash defaults, not the values selected for a particular invocation.
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
        if let Some(retirement) = &self.retirement {
            retirement.validate()?;
        }
        self.settings.validate().map_err(str::to_owned)
    }

    pub fn new(id: ModelId, display_name: impl Into<String>) -> Self {
        Self {
            id,
            display_name: display_name.into(),
            description: None,
            access: ModelAccess::Unknown,
            retirement: None,
            context_window: ContextWindow::Unknown,
            auto_compact_token_limit: None,
            capabilities: ModelCapabilities::UNKNOWN,
            supported_reasoning_efforts: Vec::new(),
            default_reasoning_effort: None,
            default_personality: None,
            settings: crate::ModelSettings::default(),
        }
    }
}

pub type Model = ModelInfo;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub struct ModelPreset {
    pub id: String,
    pub name: String,
    pub model: ModelRef,
    pub model_reasoning_effort: Option<ReasoningEffort>,
    pub personality: Option<Personality>,
}
