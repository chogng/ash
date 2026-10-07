use crate::ApiError;
use ash_client::SseFrame;
use ash_protocol::ModelStreamEvent;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;

/// Decodes OpenAI Chat Completions chunks and assembles one terminal choice.
///
/// The request contract fixes `n` to its provider default of one. This decoder
/// therefore consumes choice index zero, emits text and reasoning deltas in
/// order, and retains Tool Call fragments for the terminal response.
pub struct OpenAiChatCompletionsSseDecoder {
    terminal: bool,
    saw_chunk: bool,
    content: String,
    reasoning: String,
    refusal: String,
    tool_calls: BTreeMap<u64, ToolCallState>,
    finish_reason: Option<String>,
    usage: Option<Value>,
}

impl Default for OpenAiChatCompletionsSseDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenAiChatCompletionsSseDecoder {
    pub fn new() -> Self {
        Self {
            terminal: false,
            saw_chunk: false,
            content: String::new(),
            reasoning: String::new(),
            refusal: String::new(),
            tool_calls: BTreeMap::new(),
            finish_reason: None,
            usage: None,
        }
    }

    pub fn decode(&mut self, frame: &SseFrame) -> Result<Vec<ModelStreamEvent>, ApiError> {
        let SseFrame::Event(event) = frame else {
            return Ok(Vec::new());
        };
        if self.terminal {
            return Err(ApiError::InvalidResponse(
                "Chat Completions stream emitted an event after [DONE]".into(),
            ));
        }
        if event.data.trim() == "[DONE]" {
            if !self.saw_chunk || self.finish_reason.is_none() {
                return Err(ApiError::InvalidResponse(
                    "Chat Completions stream reached [DONE] before a terminal choice".into(),
                ));
            }
            self.terminal = true;
            return Ok(Vec::new());
        }

        let payload: Value = serde_json::from_str(&event.data).map_err(|_| {
            ApiError::InvalidResponse("Chat Completions stream event contains invalid JSON".into())
        })?;
        self.saw_chunk = true;
        if let Some(usage) = payload.get("usage")
            && !usage.is_null()
        {
            self.usage = Some(usage.clone());
        }

        let Some(choice) = payload
            .get("choices")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|choice| choice.get("index").and_then(Value::as_u64).unwrap_or(0) == 0)
        else {
            return Ok(Vec::new());
        };
        if let Some(reason) = choice.get("finish_reason")
            && !reason.is_null()
        {
            self.finish_reason = Some(
                reason
                    .as_str()
                    .ok_or_else(|| {
                        ApiError::InvalidResponse(
                            "Chat Completions finish_reason is not text".into(),
                        )
                    })?
                    .into(),
            );
        }
        let Some(delta) = choice.get("delta") else {
            return Ok(Vec::new());
        };
        let mut events = Vec::new();
        if let Some(content) = optional_string(delta, "content")? {
            self.content.push_str(content);
            if !content.is_empty() {
                events.push(ModelStreamEvent::TextDelta(content.into()));
            }
        }
        if let Some(reasoning) = optional_string(delta, "reasoning_content")? {
            self.reasoning.push_str(reasoning);
            if !reasoning.is_empty() {
                events.push(ModelStreamEvent::ReasoningDelta(reasoning.into()));
            }
        }
        if let Some(refusal) = optional_string(delta, "refusal")? {
            self.refusal.push_str(refusal);
        }
        for call in delta
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            self.decode_tool_call(call)?;
        }
        Ok(events)
    }

    /// Verifies that the stream ended with the protocol `[DONE]` marker.
    pub fn finish(self) -> Result<(), ApiError> {
        self.validate_terminal()
    }

    /// Returns a unary-compatible response assembled from streamed chunks.
    pub fn finish_response(self) -> Result<Value, ApiError> {
        self.validate_terminal()?;
        let tool_calls = self
            .tool_calls
            .into_values()
            .map(ToolCallState::finish)
            .collect::<Result<Vec<_>, _>>()?;
        let mut message = serde_json::Map::new();
        message.insert("role".into(), Value::String("assistant".into()));
        if !self.content.is_empty() {
            message.insert("content".into(), Value::String(self.content));
        }
        if !self.reasoning.is_empty() {
            message.insert("reasoning_content".into(), Value::String(self.reasoning));
        }
        if !self.refusal.is_empty() {
            message.insert("refusal".into(), Value::String(self.refusal));
        }
        if !tool_calls.is_empty() {
            message.insert("tool_calls".into(), Value::Array(tool_calls));
        }
        let mut response = json!({
            "choices": [{
                "index": 0,
                "message": Value::Object(message),
                "finish_reason": self.finish_reason,
            }]
        });
        if let Some(usage) = self.usage {
            response["usage"] = usage;
        }
        Ok(response)
    }

    fn validate_terminal(&self) -> Result<(), ApiError> {
        if self.terminal {
            Ok(())
        } else {
            Err(ApiError::InvalidResponse(
                "Chat Completions stream ended before [DONE]".into(),
            ))
        }
    }

    fn decode_tool_call(&mut self, call: &Value) -> Result<(), ApiError> {
        let index = call.get("index").and_then(Value::as_u64).ok_or_else(|| {
            ApiError::InvalidResponse("streamed Tool Call is missing its index".into())
        })?;
        let state = self.tool_calls.entry(index).or_default();
        if let Some(kind) = optional_string(call, "type")?
            && kind != "function"
        {
            return Err(ApiError::InvalidResponse(
                "Chat Completions streamed an unsupported Tool Call type".into(),
            ));
        }
        append_fragment(&mut state.id, optional_string(call, "id")?);
        if let Some(function) = call.get("function") {
            append_fragment(&mut state.name, optional_string(function, "name")?);
            append_fragment(
                &mut state.arguments,
                optional_string(function, "arguments")?,
            );
        }
        Ok(())
    }
}

#[derive(Default)]
struct ToolCallState {
    id: String,
    name: String,
    arguments: String,
}

impl ToolCallState {
    fn finish(self) -> Result<Value, ApiError> {
        if self.id.is_empty() || self.name.is_empty() {
            return Err(ApiError::InvalidResponse(
                "streamed Tool Call is missing its identity".into(),
            ));
        }
        serde_json::from_str::<Value>(&self.arguments).map_err(|_| {
            ApiError::InvalidResponse("streamed Tool Call arguments are invalid JSON".into())
        })?;
        Ok(json!({
            "id": self.id,
            "type": "function",
            "function": {
                "name": self.name,
                "arguments": self.arguments,
            }
        }))
    }
}

fn optional_string<'a>(value: &'a Value, field: &str) -> Result<Option<&'a str>, ApiError> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        Some(_) => Err(ApiError::InvalidResponse(format!(
            "Chat Completions stream field '{field}' is not text"
        ))),
    }
}

fn append_fragment(target: &mut String, fragment: Option<&str>) {
    if let Some(fragment) = fragment {
        target.push_str(fragment);
    }
}
