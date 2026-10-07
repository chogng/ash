//! The model-visible tool surface frozen for one accepted Turn.

use crate::ToolName;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

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
    pub parallel_tool_calls: bool,
}
