//! Declarations, calls, and results for tools executed by a connected client.

use crate::ToolCallId;
use crate::ToolName;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DynamicToolSpec {
    pub name: ToolName,
    pub description: String,
    #[ts(type = "unknown")]
    pub input_schema: Value,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DynamicToolCall {
    pub call_id: ToolCallId,
    pub name: ToolName,
    /// Digest of the exact model-visible definition that produced this call.
    ///
    /// Interaction owners must echo results only for this frozen definition. This prevents a
    /// same-name tool installed after a restart or hot reload from claiming an older invocation.
    pub definition_digest: String,
    #[ts(type = "unknown")]
    pub arguments: Value,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DynamicToolResponse {
    pub call_id: ToolCallId,
    pub content: Vec<DynamicToolOutput>,
    pub success: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DynamicToolOutput {
    Text { text: String },
    Image { data_url: String },
}
