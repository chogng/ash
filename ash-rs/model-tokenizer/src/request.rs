use ash_protocol::ContentPart;
use ash_protocol::InputItem;
use ash_protocol::Message;
use ash_protocol::MessageRole;
use ash_protocol::ModelRequest;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolResult;
use hf_chat_template::Message as TemplateMessage;
use hf_chat_template::RenderInput;
use serde_json::json;

pub(crate) fn render_input(
    request: &ModelRequest,
    globals: &serde_json::Map<String, serde_json::Value>,
) -> Option<RenderInput> {
    let mut messages = Vec::new();
    if let Some(instructions) = request.instructions.as_deref() {
        messages.push(TemplateMessage::system(instructions));
    }
    for item in &request.input {
        messages.push(match item {
            InputItem::Message(message) => message_value(message)?,
            InputItem::ToolResult(result) => tool_result_value(result)?,
        });
    }

    let mut extra = globals.clone();
    if let Some(reasoning) = &request.reasoning {
        extra.insert("enable_thinking".into(), serde_json::Value::Bool(true));
        extra.insert("reasoning_effort".into(), json!(reasoning.effort));
    }
    Some(RenderInput {
        messages,
        tools: request.tools.iter().map(tool_value).collect(),
        documents: Vec::new(),
        add_generation_prompt: true,
        extra,
    })
}

fn message_value(message: &Message) -> Option<TemplateMessage> {
    let content = text_content(&message.content)?;
    let mut value = TemplateMessage::new(role(message.role), content);
    if !message.tool_calls.is_empty() {
        value.tool_calls = message
            .tool_calls
            .iter()
            .map(|call| {
                json!({
                    "id": call.id.as_str(),
                    "type": "function",
                    "function": {
                        "name": call.name.as_str(),
                        "arguments": call.arguments,
                    }
                })
            })
            .collect();
    }
    Some(value)
}

fn tool_result_value(result: &ToolResult) -> Option<TemplateMessage> {
    let mut message = TemplateMessage::tool(text_content(&result.content)?);
    message
        .extra
        .insert("name".into(), json!(result.name.as_str()));
    message
        .extra
        .insert("tool_call_id".into(), json!(result.call_id.as_str()));
    message
        .extra
        .insert("is_error".into(), json!(result.is_error));
    Some(message)
}

fn text_content(content: &[ContentPart]) -> Option<String> {
    let mut text = String::new();
    for part in content {
        match part {
            ContentPart::Text(part) => text.push_str(part),
            ContentPart::ImageAttachment { .. }
            | ContentPart::AudioAttachment { .. }
            | ContentPart::AudioUrl { .. } => return None,
            ContentPart::ImageUrl { .. } => return None,
        }
    }
    Some(text)
}

fn tool_value(tool: &ToolDefinition) -> serde_json::Value {
    json!({
        "type": "function",
        "function": {
            "name": tool.name.as_str(),
            "description": tool.description,
            "parameters": tool.parameters,
            "strict": tool.strict,
        }
    })
}

fn role(role: MessageRole) -> &'static str {
    match role {
        MessageRole::System => "system",
        MessageRole::Developer => "developer",
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
    }
}
