//! Canonical model input messages, media parts, and tool calls/results.

use std::borrow::Cow;

use crate::AudioAttachmentRef;
use crate::ImageAttachmentRef;
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<MessagePhase>,
    pub content: Vec<ContentPart>,
    pub tool_calls: Vec<ToolCall>,
}

impl Message {
    pub fn text(role: MessageRole, text: impl Into<String>) -> Self {
        Self {
            role,
            phase: None,
            content: vec![ContentPart::Text(text.into())],
            tool_calls: Vec::new(),
        }
    }
}

/// The purpose of one assistant message, independent from generation or Turn completion.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MessagePhase {
    Commentary,
    PartialAnswer,
    FinalAnswer,
    Other(String),
}

impl MessagePhase {
    pub fn from_wire(value: &str) -> Self {
        match value {
            "commentary" => Self::Commentary,
            "partial_answer" => Self::PartialAnswer,
            "final_answer" => Self::FinalAnswer,
            value => Self::Other(value.into()),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::Commentary => "commentary",
            Self::PartialAnswer => "partial_answer",
            Self::FinalAnswer => "final_answer",
            Self::Other(value) => value,
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
