//! Result disclosure requested explicitly by an already executed tool.

use crate::ContentPart;
use crate::ToolCallId;
use crate::ToolName;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// A terminal result withheld from model context until the user decides to share it.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolResultReview {
    pub reason: String,
    /// Captured, inspectable output. Persisted attachment references have no result item yet
    /// and are rejected at the durable interaction boundary; producers supply media URLs.
    pub content: Vec<ContentPart>,
    pub is_error: bool,
}

/// Core supplies the executed call identity; a tool cannot select another invocation.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolResultReviewRequest {
    pub tool_call_id: ToolCallId,
    pub tool_name: ToolName,
    pub review: ToolResultReview,
}

/// Sharing is a disclosure decision, never an execution grant or a request to undo effects.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ToolResultReviewDecision {
    Share,
    Skip,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolResultReviewResponse {
    pub decision: ToolResultReviewDecision,
}
