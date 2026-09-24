use crate::ModelRef;
use crate::ReasoningEffort;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Immutable model and budget selected for consultations in one Turn.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdvisorConfig {
    pub model: ModelRef,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(default = "default_max_calls")]
    #[schemars(range(min = 1, max = 16))]
    pub max_calls: u32,
    #[serde(default = "default_max_output_tokens")]
    #[schemars(range(min = 256, max = 32768))]
    pub max_output_tokens: u32,
}

impl AdvisorConfig {
    pub fn new(model: ModelRef) -> Self {
        Self {
            model,
            enabled: true,
            reasoning_effort: None,
            max_calls: default_max_calls(),
            max_output_tokens: default_max_output_tokens(),
        }
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if !(1..=16).contains(&self.max_calls) {
            return Err("advisor maxCalls must be between 1 and 16 per Turn");
        }
        if !(256..=32_768).contains(&self.max_output_tokens) {
            return Err("advisor maxOutputTokens must be between 256 and 32768");
        }
        Ok(())
    }
}

const fn default_max_calls() -> u32 {
    3
}

const fn default_enabled() -> bool {
    true
}

const fn default_max_output_tokens() -> u32 {
    2048
}

/// Durable conversation preference; defaults are resolved before each Turn starts.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AdvisorSelection {
    #[default]
    Default,
    Off,
    Model {
        config: AdvisorConfig,
    },
}

impl AdvisorSelection {
    pub fn resolve(&self, default: Option<&AdvisorConfig>) -> Option<AdvisorConfig> {
        let config = match self {
            Self::Default => default.cloned(),
            Self::Off => None,
            Self::Model { config } => Some(config.clone()),
        };
        config.filter(|config| config.enabled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ModelId, ProviderId};

    #[test]
    fn old_config_defaults_to_enabled_and_disabled_config_does_not_resolve() {
        let config: AdvisorConfig = serde_json::from_value(serde_json::json!({
            "model": { "provider": "openai", "model": "reviewer" }
        }))
        .unwrap();
        assert!(config.enabled);
        assert_eq!(
            AdvisorSelection::Default.resolve(Some(&config)),
            Some(config.clone())
        );
        let disabled = AdvisorConfig {
            enabled: false,
            ..AdvisorConfig::new(ModelRef::new(
                ProviderId::new("openai").unwrap(),
                ModelId::new("reviewer").unwrap(),
            ))
        };
        assert_eq!(AdvisorSelection::Default.resolve(Some(&disabled)), None);
        assert_eq!(
            AdvisorSelection::Model { config: disabled }.resolve(None),
            None
        );
    }
}
