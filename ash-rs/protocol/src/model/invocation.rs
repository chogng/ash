use std::borrow::Cow;

use crate::AudioAttachmentRef;
use crate::ImageAttachmentRef;
use crate::ModelId;
use crate::ReasoningEffort;
use crate::ToolCallId;
use crate::ToolName;
use schemars::JsonSchema;
use schemars::Schema;
use schemars::SchemaGenerator;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;
use serde_json::Value;
use ts_rs::TS;
use ts_rs::TypeVisitor;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequest {
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
    /// Applies the last provider-capability gate to every image before wire encoding.
    ///
    /// The returned decisions are suitable for bounded diagnostics; image URLs and bytes are not
    /// copied into them.
    pub fn sanitize_image_details(
        &mut self,
        supports_original: bool,
    ) -> Vec<crate::ImageDetailDecision> {
        let mut decisions = Vec::new();
        for item in &mut self.input {
            match item {
                InputItem::Message(message) => {
                    sanitize_content(&mut message.content, supports_original, &mut decisions)
                }
                InputItem::ToolResult(result) => {
                    sanitize_content(&mut result.content, supports_original, &mut decisions)
                }
                InputItem::Reasoning(_) => {}
            }
        }
        decisions
    }
}

fn sanitize_content(
    content: &mut [ContentPart],
    supports_original: bool,
    decisions: &mut Vec<crate::ImageDetailDecision>,
) {
    for part in content {
        let detail = match part {
            ContentPart::ImageUrl { detail, .. } | ContentPart::ImageAttachment { detail, .. } => {
                detail
            }
            ContentPart::Text(_)
            | ContentPart::AudioAttachment { .. }
            | ContentPart::AudioUrl { .. } => continue,
        };
        let requested = *detail;
        let (effective, reason) = if requested == ImageDetail::Original && !supports_original {
            (
                ImageDetail::Auto,
                crate::ImageDetailDecisionReason::OriginalUnsupportedDowngraded,
            )
        } else {
            (requested, crate::ImageDetailDecisionReason::Supported)
        };
        *detail = effective;
        decisions.push(crate::ImageDetailDecision {
            requested,
            effective,
            reason,
        });
    }
}

impl ModelRequest {
    pub fn text(prompt: impl Into<String>) -> Self {
        Self {
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

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum InputItem {
    Message(Message),
    ToolResult(ToolResult),
    Reasoning(ReasoningState),
}

/// An encrypted Responses reasoning item, replayable only in its original credential/model scope.
/// The wire item is retained unchanged, including provider extensions and summary blocks.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningState {
    pub scope: String,
    #[ts(type = "unknown")]
    pub item: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: MessageRole,
    pub content: Vec<ContentPart>,
    pub tool_calls: Vec<ToolCall>,
}

impl Message {
    pub fn text(role: MessageRole, text: impl Into<String>) -> Self {
        Self {
            role,
            content: vec![ContentPart::Text(text.into())],
            tool_calls: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MessageRole {
    System,
    Developer,
    User,
    Assistant,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ContentPart {
    Text(String),
    AudioAttachment {
        attachment: AudioAttachmentRef,
    },
    AudioUrl {
        url: String,
    },
    ImageAttachment {
        attachment: ImageAttachmentRef,
        detail: ImageDetail,
    },
    ImageUrl {
        url: String,
        detail: ImageDetail,
    },
}

#[derive(JsonSchema, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum ContentPartWire {
    AudioAttachment {
        attachment: AudioAttachmentRef,
    },
    AudioUrl {
        url: String,
    },
    Text {
        text: String,
    },
    ImageAttachment {
        attachment: ImageAttachmentRef,
        detail: ImageDetail,
    },
    ImageUrl {
        url: String,
        detail: ImageDetail,
    },
}

#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum ContentPartRef<'a> {
    AudioAttachment {
        attachment: &'a AudioAttachmentRef,
    },
    AudioUrl {
        url: &'a str,
    },
    Text {
        text: &'a str,
    },
    ImageAttachment {
        attachment: &'a ImageAttachmentRef,
        detail: ImageDetail,
    },
    ImageUrl {
        url: &'a str,
        detail: ImageDetail,
    },
}

impl Serialize for ContentPart {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Text(text) => ContentPartRef::Text { text }.serialize(serializer),
            Self::AudioAttachment { attachment } => {
                ContentPartRef::AudioAttachment { attachment }.serialize(serializer)
            }
            Self::AudioUrl { url } => ContentPartRef::AudioUrl { url }.serialize(serializer),
            Self::ImageAttachment { attachment, detail } => ContentPartRef::ImageAttachment {
                attachment,
                detail: *detail,
            }
            .serialize(serializer),
            Self::ImageUrl { url, detail } => ContentPartRef::ImageUrl {
                url,
                detail: *detail,
            }
            .serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for ContentPart {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        ContentPartWire::deserialize(deserializer).map(Into::into)
    }
}

impl From<ContentPartWire> for ContentPart {
    fn from(part: ContentPartWire) -> Self {
        match part {
            ContentPartWire::Text { text } => Self::Text(text),
            ContentPartWire::AudioAttachment { attachment } => Self::AudioAttachment { attachment },
            ContentPartWire::AudioUrl { url } => Self::AudioUrl { url },
            ContentPartWire::ImageAttachment { attachment, detail } => {
                Self::ImageAttachment { attachment, detail }
            }
            ContentPartWire::ImageUrl { url, detail } => Self::ImageUrl { url, detail },
        }
    }
}

impl JsonSchema for ContentPart {
    fn schema_name() -> Cow<'static, str> {
        "ContentPart".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        ContentPartWire::json_schema(generator)
    }
}

impl TS for ContentPart {
    type WithoutGenerics = Self;
    type OptionInnerType = Self;

    const IS_ENUM: bool = true;

    fn name(_: &ts_rs::Config) -> String {
        "ContentPart".into()
    }

    fn inline(cfg: &ts_rs::Config) -> String {
        format!(
            "{{ \"type\": \"text\", text: string, }} | {{ \"type\": \"imageAttachment\", attachment: {}, detail: {}, }} | {{ \"type\": \"imageUrl\", url: string, detail: {}, }} | {{ \"type\": \"audioAttachment\", attachment: {}, }} | {{ \"type\": \"audioUrl\", url: string, }}",
            ImageAttachmentRef::name(cfg),
            ImageDetail::name(cfg),
            ImageDetail::name(cfg),
            AudioAttachmentRef::name(cfg),
        )
    }

    fn decl(cfg: &ts_rs::Config) -> String {
        format!("type {} = {};", Self::name(cfg), Self::inline(cfg))
    }

    fn decl_concrete(cfg: &ts_rs::Config) -> String {
        Self::decl(cfg)
    }

    fn visit_dependencies(visitor: &mut impl TypeVisitor)
    where
        Self: 'static,
    {
        visitor.visit::<ImageAttachmentRef>();
        visitor.visit::<AudioAttachmentRef>();
        visitor.visit::<ImageDetail>();
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ImageDetail {
    Auto,
    Low,
    High,
    Original,
}

/// Stable explanation for a final model-request image detail decision.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ImageDetailDecisionReason {
    Supported,
    OriginalUnsupportedDowngraded,
}

/// Observable result of the final model-request image detail gate.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDetailDecision {
    pub requested: ImageDetail,
    pub effective: ImageDetail,
    pub reason: ImageDetailDecisionReason,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: ToolName,
    pub description: String,
    pub parameters: Value,
    pub strict: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: ToolCallId,
    pub name: ToolName,
    pub arguments: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub call_id: ToolCallId,
    pub name: ToolName,
    pub content: Vec<ContentPart>,
    pub is_error: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "name", rename_all = "camelCase")]
pub enum ToolChoice {
    Auto,
    None,
    Required,
    Function(ToolName),
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

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    /// Total provider-accounted input tokens, including cache reads and cache writes.
    #[serde(default)]
    #[ts(type = "number | null")]
    pub input_tokens: Option<u64>,
    #[serde(default)]
    #[ts(type = "number | null")]
    pub output_tokens: Option<u64>,
    /// Input tokens read from a provider prompt cache.
    #[serde(default)]
    #[ts(type = "number | null")]
    pub cached_input_tokens: Option<u64>,
    /// Input tokens written to a provider prompt cache.
    #[serde(default)]
    #[ts(type = "number | null")]
    pub cache_write_input_tokens: Option<u64>,
    #[serde(default)]
    #[ts(type = "number | null")]
    pub reasoning_tokens: Option<u64>,
}

/// Invocation input estimate recorded beside provider usage for future budget calibration.
///
/// The estimate remains distinct from provider-reported usage: it describes the canonical request
/// before the call, while [`ModelUsage`] describes what the provider reported after the call.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelInputEstimate {
    #[ts(type = "number")]
    pub estimated_input_tokens: u64,
    pub estimator_revision: String,
    pub calibration_revision: String,
}

/// Latest model-visible context size retained for one Turn.
///
/// Provider-reported token counts are preferred. When a provider omits input or output usage,
/// Core may retain its deterministic request estimate so clients can distinguish an estimate from
/// an exact provider measurement.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelContextUsage {
    #[ts(type = "number")]
    pub used_tokens: u64,
    pub source: ModelContextUsageSource,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ModelContextUsageSource {
    ProviderReported,
    Estimated,
}

/// One aggregate token metric built only from values explicitly reported by providers.
///
/// `reported` remains useful as a lower bound when one or more invocations omitted this metric;
/// `complete` says whether the reported value is also the exact aggregate.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageTotal {
    #[ts(type = "number")]
    pub reported: u64,
    pub complete: bool,
}

impl Default for ModelUsageTotal {
    fn default() -> Self {
        Self {
            reported: 0,
            complete: true,
        }
    }
}

impl ModelUsageTotal {
    fn checked_record(&self, value: Option<u64>) -> Option<Self> {
        Some(Self {
            reported: self.reported.checked_add(value.unwrap_or_default())?,
            complete: self.complete && value.is_some(),
        })
    }
}

/// Provider-reported usage aggregated across every model response in a Thread or Turn.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageSummary {
    #[ts(type = "number")]
    pub model_invocations: u64,
    pub input_tokens: ModelUsageTotal,
    pub output_tokens: ModelUsageTotal,
    pub cached_input_tokens: ModelUsageTotal,
    #[serde(default)]
    pub cache_write_input_tokens: ModelUsageTotal,
    pub reasoning_tokens: ModelUsageTotal,
}

impl ModelUsageSummary {
    /// Returns the next exact projection, or `None` if any counter would overflow.
    pub fn checked_record(&self, usage: Option<&ModelUsage>) -> Option<Self> {
        Some(Self {
            model_invocations: self.model_invocations.checked_add(1)?,
            input_tokens: self
                .input_tokens
                .checked_record(usage.and_then(|usage| usage.input_tokens))?,
            output_tokens: self
                .output_tokens
                .checked_record(usage.and_then(|usage| usage.output_tokens))?,
            cached_input_tokens: self
                .cached_input_tokens
                .checked_record(usage.and_then(|usage| usage.cached_input_tokens))?,
            cache_write_input_tokens: self
                .cache_write_input_tokens
                .checked_record(usage.and_then(|usage| usage.cache_write_input_tokens))?,
            reasoning_tokens: self
                .reasoning_tokens
                .checked_record(usage.and_then(|usage| usage.reasoning_tokens))?,
        })
    }
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
