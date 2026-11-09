//! Canonical feature identities, lifecycle, defaults and resolved sources.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(
    Clone, Copy, Debug, Deserialize, Eq, JsonSchema, Ord, PartialEq, PartialOrd, Serialize, TS,
)]
#[serde(rename_all = "camelCase")]
pub enum Feature {
    CodeMode,
    Queue,
    Analytics,
    Memories,
    ChatMemories,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum FeatureStage {
    Experimental,
    Stable,
    Deprecated,
    Removed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum FeatureSource {
    Default,
    User,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FeatureState {
    pub feature: Feature,
    pub stage: FeatureStage,
    pub enabled: bool,
    pub source: FeatureSource,
}

pub type FeatureOverrides = BTreeMap<Feature, bool>;

impl Feature {
    pub const ALL: [Self; 5] = [
        Self::CodeMode,
        Self::Queue,
        Self::Analytics,
        Self::Memories,
        Self::ChatMemories,
    ];

    pub fn stage(self) -> FeatureStage {
        match self {
            Self::CodeMode | Self::Queue | Self::Memories | Self::ChatMemories => {
                FeatureStage::Stable
            }
            Self::Analytics => FeatureStage::Experimental,
        }
    }

    pub fn default_enabled(self) -> bool {
        matches!(self, Self::CodeMode | Self::Queue | Self::ChatMemories)
    }

    pub fn enabled(self, overrides: &FeatureOverrides) -> bool {
        self.stage() != FeatureStage::Removed
            && overrides
                .get(&self)
                .copied()
                .unwrap_or(self.default_enabled())
    }
}

/// Resolve built-in defaults and the typed, user-owned overrides in deterministic order.
pub fn resolve(overrides: &FeatureOverrides) -> Vec<FeatureState> {
    Feature::ALL
        .into_iter()
        .map(|feature| FeatureState {
            feature,
            stage: feature.stage(),
            enabled: feature.enabled(overrides),
            source: if overrides.contains_key(&feature) {
                FeatureSource::User
            } else {
                FeatureSource::Default
            },
        })
        .collect()
}

#[cfg(test)]
#[path = "features_tests.rs"]
mod tests;
