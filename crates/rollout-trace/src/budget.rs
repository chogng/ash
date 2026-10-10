use ash_protocol::ContentPart;
use ash_protocol::InputItem;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ResponseItem;
use ash_protocol::ToolCall;
use serde_json::Value;

// Account for collection nodes as well as text before cloning. This visits borrowed values;
// JSON encoding, hashing and file writes happen only on the recording worker.
pub(super) struct Budget {
    bytes: usize,
    limit: usize,
}

impl Budget {
    pub(super) fn new(limit: usize) -> Self {
        Self { bytes: 1024, limit }
    }
    pub(super) fn add(&mut self, bytes: usize) -> Result<(), ()> {
        self.bytes = self.bytes.checked_add(bytes).ok_or(())?;
        if self.bytes > self.limit {
            return Err(());
        }
        Ok(())
    }
    pub(super) fn string(&mut self, value: &str) -> Result<(), ()> {
        self.add(value.len() + 64)
    }
    pub(super) fn finish(self) -> usize {
        self.bytes
    }
    pub(super) fn json(&mut self, value: &Value, depth: usize) -> Result<(), ()> {
        if depth > 64 {
            return Err(());
        }
        self.add(128)?;
        match value {
            Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
            Value::String(value) => self.string(value),
            Value::Array(values) => {
                for value in values {
                    self.json(value, depth + 1)?;
                }
                Ok(())
            }
            Value::Object(values) => {
                for (key, value) in values {
                    self.string(key)?;
                    self.json(value, depth + 1)?;
                }
                Ok(())
            }
        }
    }
    fn content(&mut self, parts: &[ContentPart]) -> Result<(), ()> {
        for part in parts {
            self.add(std::mem::size_of::<ContentPart>())?;
            match part {
                ContentPart::Text(text)
                | ContentPart::ImageUrl { url: text, .. }
                | ContentPart::AudioUrl { url: text } => self.string(text)?,
                ContentPart::ImageAttachment { attachment, .. } => {
                    self.string(attachment.content_digest.as_str())?
                }
                ContentPart::AudioAttachment { attachment } => {
                    self.string(attachment.content_digest.as_str())?
                }
            }
        }
        Ok(())
    }
    fn call(&mut self, call: &ToolCall) -> Result<(), ()> {
        self.add(std::mem::size_of::<ToolCall>())?;
        self.string(call.id.as_str())?;
        self.string(call.name.as_str())?;
        self.json(&call.arguments, 0)
    }
    fn optional_string(&mut self, value: Option<&str>) -> Result<(), ()> {
        if let Some(value) = value {
            self.string(value)?;
        }
        Ok(())
    }
}

pub(super) fn request_bytes(request: &ModelRequest, limit: usize) -> Option<usize> {
    let mut budget = Budget::new(limit);
    let result = (|| {
        // Destructure the request so a new retained field requires an explicit budget decision.
        let ModelRequest {
            verbosity: _,
            reasoning_summary: _,
            speed: _,
            parallel_tool_calls: _,
            reasoning: _,
            max_output_tokens: _,
            temperature: _,
            prompt_cache_prefix_end: _,
            instructions,
            service_tier,
            prompt_cache_key,
            input,
            tools,
            tool_choice,
        } = request;
        for field in [instructions, service_tier, prompt_cache_key] {
            budget.optional_string(field.as_deref())?;
        }
        if let ash_protocol::ToolChoice::Function(name) = tool_choice {
            budget.string(name.as_str())?;
        }
        for item in input {
            budget.add(std::mem::size_of::<InputItem>())?;
            match item {
                InputItem::Message(message) => {
                    budget.optional_string(message.phase.as_ref().map(|phase| phase.as_str()))?;
                    budget.content(&message.content)?;
                    for call in &message.tool_calls {
                        budget.call(call)?;
                    }
                }
                InputItem::ToolResult(result) => {
                    budget.string(result.call_id.as_str())?;
                    budget.string(result.name.as_str())?;
                    budget.content(&result.content)?;
                }
                InputItem::Reasoning(state) => {
                    budget.string(&state.scope)?;
                    budget.json(&state.item, 0)?;
                }
            }
        }
        for tool in tools {
            budget.add(std::mem::size_of::<ash_protocol::ToolDefinition>())?;
            budget.string(tool.name.as_str())?;
            budget.string(&tool.description)?;
            budget.json(&tool.parameters, 0)?;
        }
        Ok::<(), ()>(())
    })();
    result.ok().map(|()| budget.finish())
}

pub(super) fn response_bytes(response: &ModelResponse, limit: usize) -> Option<usize> {
    let mut budget = Budget::new(limit);
    let result = (|| {
        let ModelResponse {
            output,
            usage: _,
            billing,
            stop_reason,
        } = response;
        if let ash_protocol::StopReason::Other(value) = stop_reason {
            budget.string(value)?;
        }
        if let Some(billing) = billing {
            budget.optional_string(billing.resolved_model.as_ref().map(|model| model.as_str()))?;
            budget.optional_string(billing.applied_service_tier.as_deref())?;
        }
        for item in output {
            budget.add(std::mem::size_of::<ResponseItem>())?;
            match item {
                ResponseItem::Text(text)
                | ResponseItem::Reasoning(text)
                | ResponseItem::Refusal(text) => budget.string(text)?,
                ResponseItem::Message(message) => {
                    budget.string(&message.id)?;
                    budget.string(&message.text)?;
                    budget.optional_string(message.phase.as_ref().map(|phase| phase.as_str()))?;
                }
                ResponseItem::ReasoningState(state) => {
                    budget.string(&state.scope)?;
                    budget.json(&state.item, 0)?;
                }
                ResponseItem::ToolCall(call) => budget.call(call)?,
            }
        }
        Ok::<(), ()>(())
    })();
    result.ok().map(|()| budget.finish())
}
