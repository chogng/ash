use crate::ConfigError;
use ash_protocol::{SkillId, SkillName, SkillSourceId};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Desired enablement for one configured Skill source.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum SkillSourceEnablement {
    #[default]
    Disabled,
    Enabled,
}

/// Desired user enablement for one discovered Skill.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum SkillEnablement {
    Disabled,
    #[default]
    Enabled,
}

/// A runtime-free, user-owned Skill source declaration.
///
/// `root_reference` is an opaque host reference, not a trusted filesystem handle. A future Skill
/// manager resolves it, checks containment and the required capability, then publishes a separate catalog snapshot.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillSourceConfig {
    pub id: SkillSourceId,
    pub root_reference: String,
    #[serde(default)]
    pub enablement: SkillSourceEnablement,
}

impl SkillSourceConfig {
    pub(crate) fn validate(&self) -> Result<(), ConfigError> {
        if self.root_reference.trim().is_empty()
            || self.root_reference.contains('\0')
            || self.root_reference.contains(['\n', '\r'])
        {
            return Err(ConfigError(
                "Skill source root reference must be non-empty plain text".into(),
            ));
        }
        Ok(())
    }
}

/// Skill source declarations owned by the user configuration authority.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillsConfig {
    #[serde(default)]
    pub sources: BTreeMap<SkillSourceId, SkillSourceConfig>,
    #[serde(default)]
    pub enablement: BTreeMap<SkillSourceId, BTreeMap<SkillName, SkillEnablement>>,
}

impl SkillsConfig {
    pub(crate) fn validate_for_namespace(&self, namespace: &str) -> Result<(), ConfigError> {
        for (source_id, source) in &self.sources {
            if &source.id != source_id {
                return Err(ConfigError(format!(
                    "Skill source entry '{}' contains declaration for '{}'",
                    source_id, source.id
                )));
            }
            if !source_id.belongs_to_namespace(namespace) {
                return Err(ConfigError(format!(
                    "Skill source '{}' is outside the '{namespace}' namespace",
                    source_id
                )));
            }
            source.validate()?;
        }
        Ok(())
    }

    pub fn skill_enablement(&self, skill_id: &SkillId) -> SkillEnablement {
        self.enablement
            .get(&skill_id.source)
            .and_then(|skills| skills.get(&skill_id.name))
            .copied()
            .unwrap_or_default()
    }

    pub(crate) fn set_skill_enablement(&mut self, skill_id: &SkillId, enablement: SkillEnablement) {
        if enablement == SkillEnablement::Enabled {
            if let Some(skills) = self.enablement.get_mut(&skill_id.source) {
                skills.remove(&skill_id.name);
                if skills.is_empty() {
                    self.enablement.remove(&skill_id.source);
                }
            }
            return;
        }
        self.enablement
            .entry(skill_id.source.clone())
            .or_default()
            .insert(skill_id.name.clone(), enablement);
    }
}
