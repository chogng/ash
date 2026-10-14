//! The model-visible tool surface frozen for one accepted Turn.

use crate::ToolName;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Semantic capability, independent of a tool's provider and execution host.
#[derive(
    Clone, Copy, Debug, Deserialize, Eq, JsonSchema, Ord, PartialEq, PartialOrd, Serialize, TS,
)]
#[serde(rename_all = "camelCase")]
pub enum ToolCategory {
    Read,
    Edit,
    Search,
    Execute,
    Browser,
    Web,
    Agent,
    Plan,
    Workbench,
    Sessions,
    Projects,
    Automations,
    App,
    Memory,
    Skills,
    Image,
}

/// A product or caller composes a scope from capability groups and exact tools.
/// An absent scope retains the host catalog; an explicit empty scope permits no tools.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolScope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// Product-authored reusable sets. Category labels never grant membership by themselves.
    #[serde(default)]
    pub sets: Vec<String>,
    /// Optional narrowing filter over the selected sets and exact tools.
    #[serde(default)]
    pub categories: Vec<ToolCategory>,
    #[serde(default)]
    pub tools: Vec<ToolName>,
}

impl ToolScope {
    pub fn validate(&self) -> Result<(), String> {
        if self.profile.as_ref().is_some_and(|id| {
            id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        }) || self.sets.len() > 256
            || self.sets.iter().any(|id| {
                id.is_empty()
                    || id.len() > 128
                    || !id.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
                    })
            })
            || self
                .sets
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != self.sets.len()
            || self.tools.len() > 4096
            || self
                .tools
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != self.tools.len()
            || self
                .categories
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != self.categories.len()
        {
            return Err("Tool scope requires valid profile/set IDs, at most 256 unique sets, unique categories and at most 4096 unique tool names".into());
        }
        Ok(())
    }

    pub fn includes(
        &self,
        name: &ToolName,
        category: Option<ToolCategory>,
        set: Option<&str>,
    ) -> bool {
        (self.tools.contains(name) || set.is_some_and(|set| self.sets.iter().any(|id| id == set)))
            && (self.categories.is_empty()
                || category.is_some_and(|category| self.categories.contains(&category)))
    }
}

/// Declared product composition; planned products never grant tools.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ToolProductStatus {
    Ready,
    Planned,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolProductProfile {
    pub id: String,
    pub sets: Vec<String>,
    pub status: ToolProductStatus,
}

/// Reusable product-authored membership, independent of category and provider grouping.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolSetDefinition {
    pub id: String,
    pub tools: Vec<ToolName>,
}

/// Immutable model-visible tool surface selected for one Turn.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolProfileSnapshot {
    pub id: String,
    pub revision: String,
    pub definition_digest: String,
    pub tool_names: Vec<ToolName>,
    /// User exclusions also apply to deferred discovery, nested calls and delegation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub disabled_tools: Vec<ToolName>,
    /// Resolved positive scope, including deferred tools, frozen before this Turn starts.
    /// Unlike loading/exposure, this is also a ceiling for search and nested execution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Vec<ToolName>>,
    pub parallel_tool_calls: bool,
}

impl ToolProfileSnapshot {
    pub fn allows_tool(&self, name: &ToolName) -> bool {
        !self.disabled_tools.contains(name)
            && self.allowed_tools.as_ref().is_none_or(|allowed| {
                allowed.contains(name)
                    || (!allowed.is_empty() && matches!(name.as_str(), "exec" | "wait"))
            })
    }
}
