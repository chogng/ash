use crate::ContentDigest;
use crate::FrozenSkillActivation;
use crate::ModelRef;
use crate::ToolName;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeSet;
use ts_rs::TS;

/// Explains how one exact Agent definition was selected for one Thread.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum AgentDefinitionSelectionReason {
    Explicit,
    Automatic,
}

/// Stable source of an Agent role selected for one run.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentRoleSource {
    BuiltIn,
    Directory { id: String },
}

/// Durable identity of the exact Agent definition consumed by an Agent configuration.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FrozenAgentDefinitionRef {
    pub name: String,
    pub source: AgentRoleSource,
    #[ts(type = "number | null")]
    pub version: Option<u64>,
    #[ts(type = "number")]
    pub catalog_generation: u64,
    pub content_digest: ContentDigest,
    pub selection_reason: AgentDefinitionSelectionReason,
}

/// Frozen Agent role instructions selected before a Thread is created.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoleSnapshot {
    pub name: String,
    pub instructions: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub model: Option<ModelRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub definition: Option<FrozenAgentDefinitionRef>,
}

/// Frozen upper bounds on tools used by this Agent, tools it may delegate, and Skill instructions.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilityScope {
    pub tools: Vec<ToolName>,
    /// Exact tools this Agent may make available to a directly delegated child.
    ///
    /// Historical seeds omit this field and therefore cannot pass tools to descendants.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub delegation_tools: Vec<ToolName>,
    pub skills: Vec<FrozenSkillActivation>,
}

/// Selects normal Agent behavior or one definition from an exact authorized source.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentRoleSelection {
    #[default]
    Default,
    Exact {
        source: AgentRoleSource,
        name: String,
    },
}

/// Immutable role and capability bounds shared by root and delegated Threads.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfiguration {
    /// None selects normal Agent behavior without a specialized role prompt.
    pub role: Option<AgentRoleSnapshot>,
    pub capability_scope: AgentCapabilityScope,
    /// Common and model instructions. Historical seeds did not record this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub base_instructions: Option<crate::TurnInstructions>,
}

impl AgentConfiguration {
    /// Returns the model preference frozen with this Agent's startup configuration.
    pub fn model(&self) -> Option<&ModelRef> {
        self.role
            .as_ref()
            .and_then(|role| role.model.as_ref())
            .or_else(|| {
                self.base_instructions
                    .as_ref()
                    .and_then(|instructions| instructions.model_guidance())
                    .and_then(|selection| selection.model())
            })
    }

    /// Checks persisted or externally supplied role and capability material.
    pub fn validate(&self) -> Result<(), &'static str> {
        if let Some(instructions) = &self.base_instructions {
            instructions
                .validate()
                .map_err(|_| "Agent base instructions are invalid")?;
        }
        if let Some(role) = &self.role {
            if role.name.trim().is_empty() || role.instructions.trim().is_empty() {
                return Err("Agent role name and instructions must not be empty");
            }
            if role.instructions.len() > 64 * 1024 {
                return Err("Agent role instructions exceed 64 KiB");
            }
            if let Some(definition) = &role.definition {
                if definition.name != role.name {
                    return Err("Agent role and definition identities must match");
                }
                if matches!(&definition.source, AgentRoleSource::Directory { id } if id.trim().is_empty())
                {
                    return Err("Agent role source must not be empty");
                }
            }
        }
        for tools in [
            &self.capability_scope.tools,
            &self.capability_scope.delegation_tools,
        ] {
            if tools.iter().collect::<BTreeSet<_>>().len() != tools.len() {
                return Err("Agent capability scope contains duplicate tools");
            }
        }
        if self
            .capability_scope
            .skills
            .iter()
            .map(|skill| &skill.id)
            .collect::<BTreeSet<_>>()
            .len()
            != self.capability_scope.skills.len()
        {
            return Err("Agent capability scope contains duplicate Skills");
        }
        Ok(())
    }
}
