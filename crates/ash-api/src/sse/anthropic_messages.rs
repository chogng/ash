use crate::ApiError;
use ash_client::SseEvent;
use ash_client::SseFrame;
use ash_protocol::ModelStreamEvent;
use serde_json::Map;
use serde_json::Value;
use std::collections::BTreeMap;

/// Decodes already-framed Anthropic Messages events into canonical deltas.
///
/// The decoder validates Anthropic's message/content-block lifecycle and
/// assembles the authoritative terminal message, including streamed Tool Use
/// arguments. It does not own SSE framing, transport liveness, or retries.
pub struct AnthropicMessagesSseDecoder {
    message_started: bool,
    terminal: bool,
    message: Option<Value>,
    blocks: BTreeMap<u64, ContentBlockState>,
    completed_blocks: BTreeMap<u64, Value>,
}

impl Default for AnthropicMessagesSseDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl AnthropicMessagesSseDecoder {
    pub fn new() -> Self {
        Self {
            message_started: false,
            terminal: false,
            message: None,
            blocks: BTreeMap::new(),
            completed_blocks: BTreeMap::new(),
        }
    }

    pub fn decode(&mut self, frame: &SseFrame) -> Result<Vec<ModelStreamEvent>, ApiError> {
        let SseFrame::Event(event) = frame else {
            return Ok(Vec::new());
        };
        if self.terminal {
            return Err(ApiError::InvalidResponse(
                "Anthropic message stream emitted an event after message_stop".into(),
            ));
        }
        self.decode_event(event)
    }

    /// Verifies that the stream ended after `message_stop` with every content
    /// block closed.
    pub fn finish(self) -> Result<(), ApiError> {
        self.validate_terminal()
    }

    /// Returns the terminal Anthropic message assembled from stream events.
    pub fn finish_response(mut self) -> Result<Value, ApiError> {
        self.validate_terminal()?;
        let mut message = self.message.take().ok_or_else(|| {
            ApiError::InvalidResponse("Anthropic message_start event is missing its message".into())
        })?;
        let message_object = message.as_object_mut().ok_or_else(|| {
            ApiError::InvalidResponse("Anthropic streamed message is not an object".into())
        })?;
        message_object.insert(
            "content".into(),
            Value::Array(self.completed_blocks.into_values().collect()),
        );
        Ok(message)
    }

    fn validate_terminal(&self) -> Result<(), ApiError> {
        if self.terminal && self.blocks.is_empty() {
            Ok(())
        } else {
            Err(ApiError::InvalidResponse(
                "Anthropic message stream ended before a valid message_stop".into(),
            ))
        }
    }

    fn decode_event(&mut self, event: &SseEvent) -> Result<Vec<ModelStreamEvent>, ApiError> {
        let payload: Value = serde_json::from_str(&event.data).map_err(|_| {
            ApiError::InvalidResponse("Anthropic message stream event contains invalid JSON".into())
        })?;
        let event_type = payload
            .get("type")
            .and_then(Value::as_str)
            .or(event.event.as_deref())
            .ok_or_else(|| {
                ApiError::InvalidResponse(
                    "Anthropic message stream event is missing its type".into(),
                )
            })?;

        match event_type {
            "message_start" => self.start_message(&payload),
            "content_block_start" => self.start_block(&payload),
            "content_block_delta" => self.decode_block_delta(&payload),
            "content_block_stop" => self.stop_block(&payload),
            "message_delta" => self.update_message(&payload),
            "message_stop" => self.stop_message(),
            "ping" => Ok(Vec::new()),
            "error" => Err(crate::requests::stream_error(&event.data)),
            _ => Ok(Vec::new()),
        }
    }

    fn start_message(&mut self, payload: &Value) -> Result<Vec<ModelStreamEvent>, ApiError> {
        if self.message_started {
            return Err(ApiError::InvalidResponse(
                "Anthropic message stream emitted message_start more than once".into(),
            ));
        }
        self.message_started = true;
        if let Some(message) = payload.get("message") {
            if !message.is_object() {
                return Err(ApiError::InvalidResponse(
                    "Anthropic message_start message is not an object".into(),
                ));
            }
            self.message = Some(message.clone());
        }
        Ok(Vec::new())
    }

    fn start_block(&mut self, payload: &Value) -> Result<Vec<ModelStreamEvent>, ApiError> {
        self.require_message_started()?;
        let index = required_index(payload)?;
        if self.blocks.contains_key(&index) || self.completed_blocks.contains_key(&index) {
            return Err(ApiError::InvalidResponse(
                "Anthropic message stream started a content block twice".into(),
            ));
        }
        let content = payload.get("content_block").cloned().ok_or_else(|| {
            ApiError::InvalidResponse(
                "Anthropic content_block_start is missing content_block".into(),
            )
        })?;
        let block_type = content.get("type").and_then(Value::as_str).ok_or_else(|| {
            ApiError::InvalidResponse(
                "Anthropic content_block_start is missing content_block.type".into(),
            )
        })?;
        self.blocks.insert(
            index,
            ContentBlockState {
                kind: ContentBlockKind::from(block_type),
                content,
                tool_json: String::new(),
            },
        );
        Ok(Vec::new())
    }

    fn decode_block_delta(&mut self, payload: &Value) -> Result<Vec<ModelStreamEvent>, ApiError> {
        self.require_message_started()?;
        let index = required_index(payload)?;
        let block = self.blocks.get_mut(&index).ok_or_else(|| {
            ApiError::InvalidResponse(
                "Anthropic message stream emitted a delta before content_block_start".into(),
            )
        })?;
        let delta = payload.get("delta").ok_or_else(|| {
            ApiError::InvalidResponse("Anthropic content_block_delta is missing delta".into())
        })?;
        let delta_type = delta.get("type").and_then(Value::as_str).ok_or_else(|| {
            ApiError::InvalidResponse("Anthropic content_block_delta is missing delta.type".into())
        })?;

        match (block.kind, delta_type) {
            (ContentBlockKind::Text, "text_delta") => {
                let text = required_string(delta, "text", "Anthropic text_delta")?;
                append_string_field(&mut block.content, "text", text)?;
                Ok(vec![ModelStreamEvent::TextDelta(text.into())])
            }
            (ContentBlockKind::Thinking, "thinking_delta") => {
                let thinking = required_string(delta, "thinking", "Anthropic thinking_delta")?;
                append_string_field(&mut block.content, "thinking", thinking)?;
                Ok(vec![ModelStreamEvent::ReasoningDelta(thinking.into())])
            }
            (ContentBlockKind::Thinking, "signature_delta") => {
                let signature = required_string(delta, "signature", "Anthropic signature_delta")?;
                append_string_field(&mut block.content, "signature", signature)?;
                Ok(Vec::new())
            }
            (ContentBlockKind::ToolUse, "input_json_delta") => {
                block.tool_json.push_str(required_string(
                    delta,
                    "partial_json",
                    "Anthropic input_json_delta",
                )?);
                Ok(Vec::new())
            }
            (ContentBlockKind::Other, _) => Ok(Vec::new()),
            _ => Err(ApiError::InvalidResponse(
                "Anthropic content block received an incompatible delta type".into(),
            )),
        }
    }

    fn stop_block(&mut self, payload: &Value) -> Result<Vec<ModelStreamEvent>, ApiError> {
        self.require_message_started()?;
        let index = required_index(payload)?;
        let mut block = self.blocks.remove(&index).ok_or_else(|| {
            ApiError::InvalidResponse(
                "Anthropic message stream stopped an unknown content block".into(),
            )
        })?;
        if block.kind == ContentBlockKind::ToolUse && !block.tool_json.is_empty() {
            let input = serde_json::from_str(&block.tool_json).map_err(|_| {
                ApiError::InvalidResponse(
                    "Anthropic streamed Tool Use arguments are invalid JSON".into(),
                )
            })?;
            object_mut(&mut block.content)?.insert("input".into(), input);
        }
        self.completed_blocks.insert(index, block.content);
        Ok(Vec::new())
    }

    fn update_message(&mut self, payload: &Value) -> Result<Vec<ModelStreamEvent>, ApiError> {
        self.require_message_started()?;
        let Some(message) = self.message.as_mut() else {
            return Ok(Vec::new());
        };
        let message = object_mut(message)?;
        if let Some(delta) = payload.get("delta").and_then(Value::as_object) {
            for field in ["stop_reason", "stop_sequence"] {
                if let Some(value) = delta.get(field) {
                    message.insert(field.into(), value.clone());
                }
            }
        }
        if let Some(usage) = payload.get("usage").and_then(Value::as_object) {
            let target = message
                .entry("usage")
                .or_insert_with(|| Value::Object(Map::new()));
            let target = object_mut(target)?;
            for (field, value) in usage {
                target.insert(field.clone(), value.clone());
            }
        }
        Ok(Vec::new())
    }

    fn stop_message(&mut self) -> Result<Vec<ModelStreamEvent>, ApiError> {
        self.require_message_started()?;
        if !self.blocks.is_empty() {
            return Err(ApiError::InvalidResponse(
                "Anthropic message stream reached message_stop with an open content block".into(),
            ));
        }
        self.terminal = true;
        Ok(Vec::new())
    }

    fn require_message_started(&self) -> Result<(), ApiError> {
        if self.message_started {
            Ok(())
        } else {
            Err(ApiError::InvalidResponse(
                "Anthropic message stream emitted a content event before message_start".into(),
            ))
        }
    }
}

struct ContentBlockState {
    kind: ContentBlockKind,
    content: Value,
    tool_json: String,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ContentBlockKind {
    Text,
    Thinking,
    ToolUse,
    Other,
}

impl ContentBlockKind {
    fn from(block_type: &str) -> Self {
        match block_type {
            "text" => Self::Text,
            "thinking" => Self::Thinking,
            "tool_use" => Self::ToolUse,
            _ => Self::Other,
        }
    }
}

fn required_index(payload: &Value) -> Result<u64, ApiError> {
    payload.get("index").and_then(Value::as_u64).ok_or_else(|| {
        ApiError::InvalidResponse("Anthropic stream event is missing content block index".into())
    })
}

fn required_string<'a>(
    value: &'a Value,
    field: &str,
    event_type: &str,
) -> Result<&'a str, ApiError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::InvalidResponse(format!("{event_type} is missing {field}")))
}

fn append_string_field(value: &mut Value, field: &str, delta: &str) -> Result<(), ApiError> {
    let object = object_mut(value)?;
    let target = object
        .entry(field)
        .or_insert_with(|| Value::String(String::new()));
    let target = target.as_str().ok_or_else(|| {
        ApiError::InvalidResponse(format!(
            "Anthropic content block field '{field}' is not text"
        ))
    })?;
    let mut combined = String::with_capacity(target.len() + delta.len());
    combined.push_str(target);
    combined.push_str(delta);
    object.insert(field.into(), Value::String(combined));
    Ok(())
}

fn object_mut(value: &mut Value) -> Result<&mut Map<String, Value>, ApiError> {
    value.as_object_mut().ok_or_else(|| {
        ApiError::InvalidResponse("Anthropic streamed content is not an object".into())
    })
}
