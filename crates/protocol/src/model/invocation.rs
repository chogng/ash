//! One canonical model call and its output; request preparation belongs to model-provider.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

use crate::InputItem;
use crate::Message;
use crate::MessageRole;
use crate::ModelId;
use crate::ModelUsage;
use crate::ReasoningEffort;
use crate::ReasoningState;
use crate::ToolCall;
use crate::ToolChoice;
use crate::ToolDefinition;

/// How one configured model runtime obtains completion output from its provider endpoint.
///
/// This describes the immutable adapter path, not whether a remote request is entitled or will
/// succeed. Unary runtimes return the completed result without synthesizing incremental deltas.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ModelOutputTransport {
    NativeStreaming,
    #[default]
    Unary,
}

/// Inference speed is independent of provider scheduling and billing service tiers.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ModelSpeed {
    Fast,
}

/// Values selected for one provider-neutral request after catalog defaults and user choices resolve.
///
/// The provider adapter translates this request into endpoint fields. Catalog declarations belong
/// to [`crate::ModelInfo`]; this request contains neither account credentials nor authorization policy.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verbosity: Option<crate::ModelVerbosity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_summary: Option<crate::ModelReasoningSummary>,
    /// Requested provider service tier; absence uses the provider default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<ModelSpeed>,
    pub instructions: Option<String>,
    pub input: Vec<InputItem>,
    pub tools: Vec<ToolDefinition>,
    pub tool_choice: ToolChoice,
    pub parallel_tool_calls: bool,
    pub reasoning: Option<ReasoningConfig>,
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_cache_key: Option<String>,
    /// Inclusive `input` index ending the reusable prompt prefix.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_cache_prefix_end: Option<u32>,
}

impl ModelRequest {
    pub fn text(prompt: impl Into<String>) -> Self {
        Self {
            verbosity: None,
            reasoning_summary: None,
            service_tier: None,
            speed: None,
            instructions: None,
            input: vec![InputItem::Message(Message::text(MessageRole::User, prompt))],
            tools: Vec::new(),
            tool_choice: ToolChoice::Auto,
            parallel_tool_calls: true,
            reasoning: None,
            max_output_tokens: None,
            temperature: None,
            prompt_cache_key: None,
            prompt_cache_prefix_end: Some(0),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningConfig {
    pub effort: ReasoningEffort,
    pub summary: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelResponse {
    pub output: Vec<ResponseItem>,
    pub usage: Option<ModelUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub billing: Option<ModelResponseBilling>,
    pub stop_reason: StopReason,
}

/// Provider-returned facts that can change how one response is billed.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelResponseBilling {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub resolved_model: Option<ModelId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub applied_service_tier: Option<String>,
}

impl ModelResponse {
    pub fn text(&self) -> String {
        self.output
            .iter()
            .filter_map(|item| match item {
                ResponseItem::Text(text) => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    pub fn tool_calls(&self) -> impl Iterator<Item = &ToolCall> {
        self.output.iter().filter_map(|item| match item {
            ResponseItem::ToolCall(call) => Some(call),
            _ => None,
        })
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum ResponseItem {
    Text(String),
    Refusal(String),
    Reasoning(String),
    ReasoningState(ReasoningState),
    ToolCall(ToolCall),
}

/// A provider-neutral incremental update produced while a model invocation is in progress.
///
/// Each value contains only newly produced content. The final [`ModelResponse`] remains the
/// authoritative invocation outcome and carries Tool Calls, usage, and stop reason.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "text", rename_all = "camelCase")]
pub enum ModelStreamEvent {
    TextDelta(String),
    ReasoningDelta(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "detail", rename_all = "camelCase")]
pub enum StopReason {
    Completed,
    ToolUse,
    MaxOutputTokens,
    Refusal,
    Other(String),
}
